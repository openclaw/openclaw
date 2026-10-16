import { createSignal, createStore, onCleanup } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { createChannelWizard, type ChannelWizardState } from "./wizard-runner.ts";

type WizardSetupDeps = {
  getContext: () => ApplicationContext;
  clearSelection: () => void;
};

export type ChannelSetup = ReturnType<typeof createChannelSetup>;

export function createChannelSetup(deps: WizardSetupDeps) {
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
      deps
        .getContext()
        .channels.state.channelsSnapshot?.channelMeta?.some((entry) => entry.id === value) ?? false,
    () => t("channels.setup.sessionExpired"),
  );
  // Completion account identity stays synchronous with the RPC runner.
  const state = projectSource(wizard, {
    read: (source) => ({ wizard: source.state, whatsappAccountId }),
    subscribe: (_source, notify) => {
      publish = notify;
      return () => {
        publish = () => {};
      };
    },
    equality: "revision",
  });
  onCleanup(() => {
    disposed = true;
    // The Gateway retains an unfinished session, so teardown cancels it.
    void wizard.cancel();
  });

  function startSetup(channel: string | null): void {
    // Completion reloads config; keep any unsaved advanced-form edits intact.
    if (deps.getContext().runtimeConfig.state.configFormDirty) {
      setBlockedByDirtyConfig(true);
      return;
    }
    setBlockedByDirtyConfig(false);
    whatsappAccountId = undefined;
    deps.clearSelection();
    void wizard.start(channel);
  }

  function close(): void {
    const wasActive = wizard.state.phase !== "idle";
    void wizard.cancel();
    if (wasActive) {
      void deps.getContext().channels.refresh(true);
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
    await context.channels.refresh(true);
    if (!isCurrent()) {
      return;
    }
    const whatsapp = current.accounts.find((entry) => entry.channel === "whatsapp");
    if (whatsapp) {
      whatsappAccountId = whatsapp.accountId;
      publish();
      await context.channels.startWhatsApp(false, whatsapp.accountId);
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
      void wizard.answer(value);
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
