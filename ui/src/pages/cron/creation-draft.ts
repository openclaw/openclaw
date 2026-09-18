import type { CronJob } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import {
  addCronJob,
  createInitialCronState,
  normalizeCronFormState,
  runCronJob,
  validateCronForm,
} from "../../lib/cron/index.ts";
import type { CronFieldErrors, CronFormState } from "../../lib/cron/types.ts";
import { showToast } from "../../lib/toast.ts";

type CreationDraft = {
  form: CronFormState;
  source: CronJob | null;
  fieldErrors: CronFieldErrors;
  error: string | null;
  pending: boolean;
  scope: ReturnType<typeof gatewayPresentationScope>;
  selectedId: string | null;
  scopeId: string | null;
  scopeCurrent: boolean;
};

type CreationListener = (saved?: { error: string | null }) => void;
const owners = new WeakMap<ApplicationContext, CronCreationDraft>();

export function cronCreationDraftFor(context: ApplicationContext): CronCreationDraft {
  let owner = owners.get(context);
  if (!owner) {
    owner = new CronCreationDraft(context);
    owners.set(context, owner);
  }
  return owner;
}

/** Retains authoring and accepted submissions while inventory stays page-owned. */
class CronCreationDraft {
  draft: CreationDraft | null = null;
  private readonly listeners = new Set<CreationListener>();
  private readonly submissions = new Set<CreationDraft>();
  private stopScope: (() => void) | undefined;

  constructor(private readonly context: ApplicationContext) {}

  subscribe(listener: CreationListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  begin(form: CronFormState, source: CronJob | null, fieldErrors: CronFieldErrors) {
    if (this.draft?.pending || this.context.lifecycleAbortSignal?.aborted) {
      return;
    }
    this.draft = {
      form,
      // Clone precision is authoring input, independent of subsequent inventory updates.
      source: source ? structuredClone(source) : null,
      fieldErrors,
      error: null,
      pending: false,
      scope: gatewayPresentationScope(this.context.gateway),
      ...this.context.agentSelection.state,
      scopeCurrent: true,
    };
    this.watchScope();
    this.publish();
  }

  patch(patch: Partial<CronFormState>) {
    const draft = this.draft;
    if (!draft || draft.pending) {
      return;
    }
    draft.form = normalizeCronFormState({ ...draft.form, ...patch }, patch);
    draft.fieldErrors = validateCronForm(draft.form);
    this.publish();
  }

  discard() {
    this.draft = null;
    this.releaseScope();
    this.publish();
  }

  async submit(runNow: boolean) {
    this.checkScope();
    const draft = this.draft;
    const { client, phase } = this.context.gateway.snapshot;
    if (!draft || draft.pending || !client || phase !== "connected") {
      return;
    }
    // Claim admission synchronously. A second page must observe it before cron.add yields.
    draft.pending = true;
    draft.error = null;
    this.submissions.add(draft);
    this.publish();
    const mutation = createInitialCronState({ client, connected: true });
    mutation.canRefresh = () => false;
    mutation.cronForm = draft.form;
    mutation.cronCloningJob = draft.source;
    try {
      const result = await addCronJob(mutation);
      if (result.saved && runNow && result.jobId && draft.scopeCurrent) {
        const snapshot = this.context.gateway.snapshot;
        // Navigation preserves accepted work; a changed live authority cannot start another write.
        if (
          snapshot.client === client &&
          snapshot.phase === "connected" &&
          readGatewayOperatorAccess(snapshot).canAdmin
        ) {
          await runCronJob(mutation, result.jobId, "force");
        }
      }
      if (this.draft !== draft) {
        return;
      }
      if (result.saved) {
        this.draft = null;
        if (mutation.cronError && this.listeners.size === 0) {
          showToast({ message: mutation.cronError });
        }
        this.publish({ error: mutation.cronError });
      } else {
        draft.error = mutation.cronError;
        draft.fieldErrors = mutation.cronFieldErrors;
      }
    } finally {
      draft.pending = false;
      this.submissions.delete(draft);
      this.releaseScope();
      this.publish();
    }
  }

  private publish(saved?: { error: string | null }) {
    for (const listener of this.listeners) {
      listener(saved);
    }
  }

  private readonly checkScope = () => {
    const { gateway, agentSelection, lifecycleAbortSignal } = this.context;
    const scope = gatewayPresentationScope(gateway);
    const selection = agentSelection.state;
    const permitted =
      !lifecycleAbortSignal?.aborted && readGatewayOperatorAccess(gateway.snapshot).canAdmin;
    for (const draft of new Set([this.draft, ...this.submissions])) {
      if (
        draft &&
        (!permitted ||
          draft.scope !== scope ||
          draft.selectedId !== selection.selectedId ||
          draft.scopeId !== selection.scopeId)
      ) {
        draft.scopeCurrent = false;
        if (this.draft === draft) {
          this.draft = null;
        }
      }
    }
    this.releaseScope();
    this.publish();
  };

  private watchScope() {
    if (this.stopScope) {
      return;
    }
    const stopGateway = this.context.gateway.subscribe(this.checkScope);
    const stopSelection = this.context.agentSelection.subscribe(this.checkScope);
    const signal = this.context.lifecycleAbortSignal;
    const abort = () => {
      this.checkScope();
      this.stopScope?.();
      this.listeners.clear();
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.stopScope = () => {
      stopGateway();
      stopSelection();
      signal?.removeEventListener("abort", abort);
      this.stopScope = undefined;
    };
  }

  private releaseScope() {
    if (!this.draft && this.submissions.size === 0) {
      this.stopScope?.();
    }
  }
}
