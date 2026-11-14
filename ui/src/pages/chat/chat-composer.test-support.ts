import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, createSignal, getOwner, merge } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { i18n } from "../../i18n/index.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { createComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { ControlUiPluginRuntime } from "../../plugins/control-ui-runtime.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { ChatProps } from "./chat-view-frame.ts";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import { ChatComposer, resetChatComposerState } from "./components/chat-composer.tsx";

type ComposerProps = ChatComposerProps &
  Pick<ChatProps, "connectionEpoch" | "onAsyncQuestionSubmit">;

const providers = new WeakMap<
  HTMLElement,
  ReturnType<typeof createSolidApplicationContextProvider>
>();

export function composerContextWrapper(container: HTMLElement) {
  return providers.get(container)?.wrapper;
}

const composers = new Map<
  HTMLElement,
  { update: (props: ComposerProps) => void; unmount: () => void }
>();

export function renderComposerInto(container: HTMLElement, props: ComposerProps) {
  const mounted = composers.get(container);
  if (mounted) {
    mounted.update(props);
  } else {
    let owner = props;
    const draftSource = createComposerDraftSource(() => ({
      draft: owner.getDraft?.() ?? owner.draft,
      mentions: owner.getMentions?.() ?? owner.mentions ?? [],
      attachments: owner.getAttachments?.() ?? owner.attachments ?? [],
      pendingAttachmentReads:
        owner.getPendingAttachmentReads?.() ?? owner.pendingAttachmentReads ?? 0,
      goalDraftMode: owner.goalDraftMode,
    }));
    const bind = (): ComposerProps => ({
      ...owner,
      draftSource: owner.draftSource ?? draftSource,
      onGoalDraftModeChange: (mode) => {
        owner.onGoalDraftModeChange?.(mode);
        if (!owner.draftSource) {
          owner.goalDraftMode = mode;
          draftSource.publish();
        }
      },
      onDraftChange: (value: string, mentions?: readonly HumanMention[]) => {
        const previous = owner.getDraft?.() ?? owner.draft;
        owner.onDraftChange(value, mentions);
        if (!owner.draftSource) {
          owner.mentions =
            owner.getMentions?.() ??
            mentions ??
            updateHumanMentions(previous, value, owner.mentions);
          owner.draft = owner.getDraft?.() ?? value;
          draftSource.publish();
        }
      },
    });
    const [current, update] = createSignal<ComposerProps>(bind(), { ownedWrite: true });
    const view = mountSolid(
      () => {
        const questions = createComposerQuestions(props.paneId, current);
        return createComponent(ChatComposer, merge(current, { questions }));
      },
      {
        container,
        wrapper: composerContextWrapper(container),
      },
    );
    composers.set(container, {
      update: (next) => {
        owner = next;
        update(bind());
        draftSource.publish();
      },
      unmount: view.unmount,
    });
    onTestFinished(() => disposeComposer(container));
  }
  if (!getOwner()) {
    flush();
  }
}

export function disposeComposer(container: HTMLElement) {
  composers.get(container)?.unmount();
  composers.delete(container);
}

export function createComposerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    paneId: crypto.randomUUID(),
    sessionKey: "main",
    currentAgentId: "main",
    connected: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: [],
    draft: "",
    modelCatalog: [],
    modelSwitching: false,
    sessions: null,
    selectedSession: overrides.sessions?.sessions.find(
      (row) => row.key === (overrides.sessionKey ?? "main"),
    ),
    assistantName: "OpenClaw",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onQueueRemove: vi.fn(),
    ...overrides,
  };
}

export function createComposerQuestionPrompt(id: string, question: string): QuestionPrompt {
  return {
    id,
    questions: [
      {
        questionId: "choice",
        header: "Choice",
        question,
        options: [{ label: "Yes" }, { label: "No" }],
        isOther: false,
      },
    ],
    sessionKey: "queue-test",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
    answeredElsewhere: false,
    localResolutionConfirmed: false,
    locallyExpired: false,
    submitting: false,
    error: null,
    drafts: new Map(),
    revision: 1,
  };
}

export function createComposerControlsFixture(): NonNullable<ComposerProps["composerControls"]> {
  return {
    component: () =>
      Object.assign(document.createElement("button"), {
        type: "button",
        className: "chat-composer-model-control",
        textContent: "Model",
      }),
    model: {
      activeRunId: null,
      connected: true,
      gatewayAvailable: false,
      loading: false,
      modelCatalog: [],
      modelCatalogState: { hasSnapshot: false, status: "idle" },
      modelSwitching: false,
      sending: false,
      sessionKey: "main",
      selectedSession: undefined,
      sessionsResult: null,
      stream: null,
    },
  };
}

export function renderComposerFixture(overrides: Partial<ComposerProps> = {}) {
  const container = createComposerContainer();
  const props = createComposerProps(overrides);
  renderComposerInto(container, props);
  return { container, props };
}

export function createComposerContainer() {
  const gateway = createApplicationGateway().gateway;
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const plugins = new ControlUiPluginRuntime(() => application);
  onTestFinished(() => runtimeConfig.dispose());
  onTestFinished(() => plugins.dispose());
  const context: Pick<
    ApplicationContext,
    "gateway" | "agentSelection" | "runtimeConfig" | "plugins"
  > = {
    gateway,
    runtimeConfig,
    plugins,
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      intentRevision: 0,
      set: () => {},
      setScope: () => {},
      subscribe: () => () => {},
    },
  };
  // SAFETY: Disconnected composer and transcript fixtures only consume these capabilities.
  const application = context as ApplicationContext;
  const container = createApplicationContextProvider(application);
  const provider = createSolidApplicationContextProvider(application);
  const setContext = container.setContext;
  container.setContext = (next) => {
    setContext(next);
    provider.setContext(next);
  };
  providers.set(container, provider);
  return container;
}

export function findComposerButton(container: Element, label: string): HTMLButtonElement {
  return expectDefined(
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
    `expected button ${label}`,
  );
}

export function findPrimaryButton(container: Element): HTMLButtonElement {
  const buttons = container
    .querySelector(".agent-chat__composer-actions")
    ?.querySelectorAll<HTMLButtonElement>(
      ":scope > .chat-desktop-primary-action > openclaw-tooltip > button",
    );
  expect(buttons).toHaveLength(1);
  return expectDefined(buttons?.[0], "expected one primary composer button");
}

export async function resetComposerFixture(afterStateReset?: () => void): Promise<void> {
  for (const container of composers.keys()) {
    disposeComposer(container);
  }
  resetChatComposerState();
  afterStateReset?.();
  localStorage.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
}
