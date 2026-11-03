import { createSignal, createStore, onSettled } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { ChannelCapability } from "../../lib/channels/index.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { createChannelWizard, type ChannelWizardState } from "./wizard-runner.ts";

export function createChannelSetup(deps: {
  getContext: () => Pick<ApplicationContext, "gateway" | "runtimeConfig">;
  channels: ChannelCapability;
  clearSelection: () => void;
  presentWizard: (pending: Promise<void>) => Promise<void>;
  retire: () => void;
  startWhatsApp: (force: boolean, accountId: string) => Promise<void>;
}) {
  const [fields, setDraft] = createStore<{
    multiselect: unknown[];
    textValue: string;
    secretVisible: boolean;
  }>({
    multiselect: [],
    textValue: "",
    secretVisible: false,
  });
  const [blockedByDirtyConfig, setBlockedByDirtyConfig] = createSignal(false);
  let whatsappAccountId: string | undefined;
  let publish = () => {};
  let stepId: string | null = null;
  let disposed = false;
  const wizard = createChannelWizard(
    () => deps.getContext().gateway.snapshot.client,
    handleWizardChange,
    (value) =>
      deps.channels.state.channelsSnapshot?.channelMeta?.some((entry) => entry.id === value) ??
      false,
    () => t("channels.setup.sessionExpired"),
  );
  // Completion account identity stays synchronous with the RPC runner.
  const state = projectMutableSource(wizard, (source) => ({
    wizard: source.state,
    whatsappAccountId,
  }));
  publish = state.publish;
  onSettled(() => () => {
    deps.retire();
    disposed = true;
    // The Gateway retains an unfinished session, so teardown cancels it.
    void wizard.cancel();
  });

  function startSetup(channel: string | null): void {
    if (deps.getContext().gateway.snapshot.phase !== "connected") {
      return;
    }
    // Completion reloads config; keep any unsaved advanced-form edits intact.
    if (deps.getContext().runtimeConfig.state.configFormDirty) {
      setBlockedByDirtyConfig(true);
      return;
    }
    setBlockedByDirtyConfig(false);
    deps.retire();
    whatsappAccountId = undefined;
    deps.clearSelection();
    void deps.presentWizard(wizard.start(channel));
  }

  function close(): void {
    deps.retire();
    const wasActive = wizard.state.phase !== "idle";
    void wizard.cancel();
    if (wasActive) {
      void deps.channels.refresh(true);
    }
  }

  function handleWizardChange(): void {
    if (disposed) {
      return;
    }
    const current = wizard.state;
    const nextStep = current.phase === "step" ? current.step : undefined;
    if ((nextStep?.id ?? null) !== stepId) {
      stepId = nextStep?.id ?? null;
      setDraft((draft) => {
        draft.multiselect = Array.isArray(nextStep?.initialValue) ? [...nextStep.initialValue] : [];
        draft.textValue =
          nextStep?.type === "text" && typeof nextStep.initialValue === "string"
            ? nextStep.initialValue
            : "";
        draft.secretVisible = false;
      });
    }
    if (current.phase === "done") {
      void handleCompleted(current);
    }
    publish();
  }

  async function handleCompleted(current: Extract<ChannelWizardState, { phase: "done" }>) {
    const context = deps.getContext();
    const isCurrent = () => wizard.state === current && deps.getContext() === context;
    await context.runtimeConfig.discardDraft({ reloadOnly: true });
    if (!isCurrent()) {
      return;
    }
    await deps.channels.refresh(true);
    if (!isCurrent()) {
      return;
    }
    const whatsapp = current.accounts.find((entry) => entry.channel === "whatsapp");
    if (whatsapp) {
      whatsappAccountId = whatsapp.accountId;
      publish();
      await deps.startWhatsApp(false, whatsapp.accountId);
    }
  }

  return {
    state: () => state.read().wizard,
    draft: fields,
    setTextValue: (value: string) =>
      setDraft((draft) => {
        draft.textValue = value;
      }),
    blockedByDirtyConfig,
    whatsappAccountId: () => state.read().whatsappAccountId,
    startSetup,
    close,
    answer: (value: unknown) => {
      void deps.presentWizard(wizard.answer(value));
    },
    toggleMultiselect: (value: unknown) =>
      setDraft((draft) => {
        draft.multiselect = draft.multiselect.includes(value)
          ? draft.multiselect.filter((entry) => entry !== value)
          : [...draft.multiselect, value];
      }),
    toggleSecretVisibility: () =>
      setDraft((draft) => {
        draft.secretVisible = !draft.secretVisible;
      }),
  };
}
