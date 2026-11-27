import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isMeetingRealtimeRouteReady } from "./meeting-modes.js";
import type { MeetingPluginConfig } from "./plugin-config.js";
import type {
  MeetingRuntimeAudioBridge,
  MeetingRuntimeFacadeConstructor,
  MeetingRuntimeFacadeOptions,
  MeetingRuntimeHookContext,
  MeetingRuntimeParams,
  MeetingRuntimeProbeResults,
  MeetingRuntimeSpeechBlockedReason,
} from "./runtime-facade-types.js";
import type { MeetingProbeContext } from "./runtime-probes.js";
import { createMeetingSession } from "./session-factory.js";
import {
  MeetingSessionRuntime,
  type MeetingSessionRuntimeHandles,
  type MeetingSessionRuntimeJoinContext,
} from "./session-runtime.js";
import type {
  MeetingBrowserTab,
  MeetingPluginChromeHealth,
  MeetingPluginJoinRequest,
  MeetingPluginSession,
} from "./session-types.js";

const nowIso = () => new Date().toISOString();

export function createMeetingRuntimeFacade<
  Config extends MeetingPluginConfig & { defaultMode: Mode },
  Transport extends "chrome" | "chrome-node",
  Mode extends string,
  Health extends MeetingPluginChromeHealth<string, string>,
  Results extends MeetingRuntimeProbeResults,
>(
  options: MeetingRuntimeFacadeOptions<Config, Transport, Mode, Health, Results>,
): MeetingRuntimeFacadeConstructor<Config, Transport, Mode, Health, Results> {
  type Session = MeetingPluginSession<Transport, Mode, Health>;
  type Request = MeetingPluginJoinRequest<Transport, Mode>;
  type JoinContext = MeetingSessionRuntimeJoinContext<
    Session,
    Transport,
    Mode,
    Health,
    MeetingBrowserTab
  >;

  return class MeetingRuntimeFacade extends MeetingSessionRuntime<
    Session,
    Request,
    Transport,
    Mode,
    Health,
    MeetingBrowserTab,
    NonNullable<Health["manualAction"]>["reason"],
    MeetingRuntimeSpeechBlockedReason<Health>
  > {
    readonly #defaultAgentId: string;

    constructor(private readonly params: MeetingRuntimeParams<Config>) {
      super({
        logger: params.logger,
        logScope: options.platform.logScope,
        formatError: formatErrorMessage,
        reuseExistingBrowserTab: params.config.chrome.reuseExistingTab,
        waitForInCallMs: params.config.chrome.waitForInCallMs,
        joinTimeoutMs: params.config.chrome.joinTimeoutMs,
        defaultSpeechInstructions: params.config.realtime.introMessage,
        transientSpeechBlockedReasons: new Set<MeetingRuntimeSpeechBlockedReason<Health>>([
          "not-in-call",
          "browser-unverified",
          options.messages.sessionRuntime.speech.microphoneMutedReason,
        ] as MeetingRuntimeSpeechBlockedReason<Health>[]),
        messages: options.messages.sessionRuntime,
        resolveJoin: (request) => this.#resolveJoin(request),
        getRequesterSessionKey: (request) => request.requesterSessionKey,
        createSession: ({ resolved, createdAt }) =>
          createMeetingSession({
            platform: options.platform,
            config: params.config,
            resolved,
            createdAt,
          }) as Session,
        resolveSpeechInstructions: (request) =>
          request.message ?? params.config.realtime.introMessage,
        isBrowserTransport: () => true,
        isTalkBackMode: (mode) => mode === "agent" || mode === "bidi",
        isTranscribeMode: (mode) => mode === "transcribe",
        sameMeetingUrl: (left, right) => options.platform.urls.isSameMeeting(left, right),
        normalizeMeetingUrlForReuse: (url) => options.platform.urls.normalizeForReuse(url),
        getBrowser: (session) =>
          session.chrome
            ? {
                launched: session.chrome.launched,
                nodeId: session.chrome.nodeId,
                tab: session.chrome.browserTab,
                health: session.chrome.health,
                hasAudioBridge:
                  options.hooks?.isAudioBridgeActive?.(session) ??
                  Boolean(session.chrome.audioBridge),
              }
            : undefined,
        setBrowserTab: (session, tab) => {
          if (session.chrome) {
            session.chrome.browserTab = tab;
          }
        },
        setBrowserHealth: (session, health) => {
          if (session.chrome) {
            session.chrome.health = health;
          }
        },
        joinTransport: async ({ request, session, context }) =>
          await this.#joinTransport(request, session, context),
        releaseBrowserTab: (session) =>
          this.releaseTrackedBrowserTab(session, {
            messages: options.messages,
            leave: (tab) =>
              options.transport.leaveInBrowser({
                runtime: params.runtime,
                config: params.config,
                meetingSessionId: session.id,
                meetingUrl: session.url,
                nodeId: session.chrome?.nodeId,
                tab,
              }),
          }),
        refreshBrowserHealth: async (session, refreshOptions) =>
          await this.#refreshBrowserHealth(session, refreshOptions),
        refreshStatus: async (session) => await this.#refreshStatus(session),
        refreshReusableSession: async (session, request) =>
          await options.hooks?.refreshReusableSession?.(session, request, this.#hookContext()),
        ensureRealtimeBridge: (session, requesterSessionKey) =>
          this.#ensureRealtimeBridge(session, requesterSessionKey),
        captureTranscript: async (session, captureOptions) =>
          await this.#captureTranscript(session, captureOptions),
        speakViaTransport: async () => undefined,
        durableTranscripts: {
          config: params.fullConfig.transcripts,
          openclawConfig: params.fullConfig,
          ...options.messages.durableTranscripts,
        },
      });
      this.#defaultAgentId = normalizeAgentId(
        params.config.realtime.agentId ?? resolveDefaultAgentId(params.fullConfig),
      );
    }

    ownsSession(agentId: string, sessionId: string): boolean {
      return this.list().some((session) => session.id === sessionId && session.agentId === agentId);
    }

    override async join(request: Request) {
      return await super.join(
        options.hooks?.normalizeJoinRequest?.(request, this.#hookContext()) ?? request,
      );
    }

    override async leave(sessionId: string) {
      return await super.leave(sessionId);
    }

    async statusForAgent(agentId: string, sessionId?: string) {
      if (sessionId) {
        return this.ownsSession(agentId, sessionId)
          ? await this.status(sessionId)
          : { found: false };
      }
      const sessions = this.list().filter((session) => session.agentId === agentId);
      await Promise.all(sessions.map((session) => this.status(session.id)));
      return { found: true, sessions };
    }

    async setupStatus(setupOptions?: { mode?: Mode; transport?: Transport }) {
      return await options.probes.setupStatus({ ...this.params, options: setupOptions });
    }

    async testSpeech(request: Request) {
      return await options.probes.testSpeech(this.#probeContext(), request);
    }

    async testListen(request: Request) {
      return await options.probes.testListening(this.#probeContext(), request);
    }

    #resolveJoin(request: Request) {
      return {
        url: options.platform.urls.validateAndNormalize(request.url),
        transport:
          request.transport ??
          ((this.params.config.chromeNode.node ? "chrome-node" : "chrome") as Transport),
        mode: request.mode ?? (this.params.config.defaultMode as Mode),
        agentId: normalizeAgentId(request.agentId ?? this.#defaultAgentId),
      };
    }

    #hookContext(): MeetingRuntimeHookContext<Session, Request, Transport, Mode, Health> {
      return {
        deleteRequesterSessionKey: (sessionId) => this.forgetMeetingRequesterSessionKey(sessionId),
        endSession: async (sessionId, leaveOptions) => {
          await super.leave(sessionId, leaveOptions);
        },
        noteSession: (session, note) => this.#noteSession(session, note),
        refreshBrowserHealth: async (session, refreshOptions) =>
          await this.refreshBrowserHealth(session, refreshOptions),
        resolvedJoin: (request) => this.#resolveJoin(request),
      };
    }

    #probeContext(): MeetingProbeContext<Config, Mode, Transport, Health, Session, Request> {
      return {
        config: this.params.config,
        resolveAgentId: (request) => normalizeAgentId(request.agentId ?? this.#defaultAgentId),
        list: () => this.list(),
        join: async (request) => await this.join(request),
        isReusable: (session, resolved) => this.isReusableSession(session, resolved),
        hasHealthHandle: (sessionId) => this.hasHealthHandle(sessionId),
        refreshHealth: (sessionId) => this.refreshHealth(sessionId),
        refreshCaptionHealth: async (session, timeoutMs) =>
          await this.#refreshBrowserHealth(session, { timeoutMs }),
      };
    }

    async #joinTransport(request: Request, session: Session, context: JoinContext) {
      const config = this.#withSessionAgentConfig(session.agentId);
      const launchParams = {
        runtime: this.params.runtime,
        config,
        fullConfig: this.params.fullConfig,
        meetingSessionId: session.id,
        requesterSessionKey: request.requesterSessionKey,
        mode: session.mode,
        url: session.url,
        logger: this.params.logger,
      };
      const result =
        session.transport === "chrome-node"
          ? await options.transport.launchOnNode(launchParams)
          : await options.transport.launchInChrome(launchParams);
      const nodeId = result.nodeId;
      const tab = context.inheritedBrowserTab({
        session,
        transport: session.transport,
        nodeId,
        meetingUrl: session.url,
        tab: result.tab,
      });
      session.chrome = {
        audioBackend: result.audioBackend,
        launched: result.launched,
        nodeId,
        browserProfile: this.params.config.chrome.browserProfile,
        browserTab: tab,
        health: result.browser,
      };
      options.hooks?.validateLaunchResult?.(result);
      const handles = this.#attachAudioBridge(session, result.audioBridge);
      if (handles) {
        context.attachRuntimeHandles(session, handles);
      }
      session.notes.push(
        result.audioBridge
          ? session.transport === "chrome-node"
            ? options.messages.joined.node
            : options.messages.joined.local
          : session.mode === "transcribe"
            ? options.messages.joined.transcribe
            : options.messages.joined.waiting,
      );
      this.refreshSpeechReadiness(session);
      return {};
    }

    #attachAudioBridge(
      session: Session,
      audioBridge: MeetingRuntimeAudioBridge<Health> | undefined,
    ): MeetingSessionRuntimeHandles<Health> | undefined {
      if (!session.chrome || !audioBridge) {
        return undefined;
      }
      session.chrome.audioBridge = {
        type: audioBridge.type,
        provider: audioBridge.providerId,
      };
      options.hooks?.afterAudioBridgeAttached?.(session);
      return {
        stop: audioBridge.stop,
        speak: audioBridge.speak,
        getHealth: audioBridge.getHealth,
      };
    }

    async #ensureRealtimeBridge(
      session: Session,
      requesterSessionKey?: string,
    ): Promise<MeetingSessionRuntimeHandles<Health> | undefined> {
      const audioBridgeActive =
        options.hooks?.isAudioBridgeActive?.(session) ?? Boolean(session.chrome?.audioBridge);
      if (
        (session.mode !== "agent" && session.mode !== "bidi") ||
        session.state !== "active" ||
        !session.chrome ||
        audioBridgeActive ||
        !isMeetingRealtimeRouteReady(session.mode, session.chrome.health)
      ) {
        return undefined;
      }
      if (session.chrome.audioBridge) {
        session.chrome.audioBridge = undefined;
      }
      const config = this.#withSessionAgentConfig(session.agentId);
      const recoveryConfig = {
        ...config,
        chrome: { ...config.chrome, launch: false },
        chromeNode: { node: session.chrome.nodeId ?? config.chromeNode.node },
      };
      const launchParams = {
        runtime: this.params.runtime,
        config: recoveryConfig,
        fullConfig: this.params.fullConfig,
        meetingSessionId: session.id,
        requesterSessionKey,
        mode: session.mode,
        trackedTargetId: session.chrome.browserTab?.targetId,
        url: session.url,
        logger: this.params.logger,
      };
      const result =
        session.transport === "chrome-node"
          ? await options.transport.launchOnNode(launchParams)
          : await options.transport.launchInChrome(launchParams);
      if (result.tab) {
        const currentTab = session.chrome.browserTab;
        session.chrome.browserTab = {
          ...result.tab,
          openedByPlugin:
            result.tab.targetId === currentTab?.targetId
              ? currentTab.openedByPlugin
              : result.tab.openedByPlugin,
        };
      }
      if (result.browser) {
        session.chrome.health = { ...session.chrome.health, ...result.browser };
      }
      session.updatedAt = nowIso();
      return this.#attachAudioBridge(session, result.audioBridge);
    }

    async #refreshStatus(session: Session): Promise<void> {
      await this.refreshBrowserHealth(session, {
        force: true,
        readOnly: !(options.hooks?.isAwaitingAdmission?.(session) ?? false),
      });
      await options.hooks?.afterStatusRefresh?.(session, this.#hookContext());
    }

    async #refreshBrowserHealth(
      session: Session,
      refreshOptions: { readOnly?: boolean; timeoutMs?: number } = {},
    ): Promise<void> {
      try {
        const result = await options.transport.recoverCurrentTab({
          runtime: this.params.runtime,
          config: this.params.config,
          fullConfig: this.params.fullConfig,
          meetingSessionId: session.id,
          mode: session.mode,
          nodeId: session.chrome?.nodeId,
          readOnly: refreshOptions.readOnly,
          trackedMeetingUrl: session.url,
          trackedTargetId: session.chrome?.browserTab?.targetId,
          transport: session.transport,
          timeoutMs: refreshOptions.timeoutMs,
          url: session.url,
        });
        // A status read can finish after leave. Its tab may now belong to a replacement.
        if (!this.canObserveBrowser(session)) {
          return;
        }
        if (result.found && session.chrome) {
          if (result.tab?.targetId) {
            const currentTab = session.chrome.browserTab;
            session.chrome.browserTab = {
              targetId: result.tab.targetId,
              openedByPlugin:
                result.tab.targetId === currentTab?.targetId ? currentTab.openedByPlugin : false,
            };
          }
          if (result.browser) {
            session.chrome.health = { ...session.chrome.health, ...result.browser };
          }
          session.updatedAt = nowIso();
        } else if (session.chrome) {
          options.hooks?.recordBrowserRecoveryFailure?.(session, {
            kind: "missing",
            message: result.message,
          });
        }
      } catch (error) {
        if (!this.canObserveBrowser(session)) {
          return;
        }
        const formattedError = formatErrorMessage(error);
        const message = options.messages.browserReadinessFailed?.(formattedError) ?? formattedError;
        if (options.hooks?.recordBrowserRecoveryFailure) {
          this.params.logger.debug?.(`${options.platform.logScope} ${message}`);
          options.hooks.recordBrowserRecoveryFailure(session, { kind: "error", message });
        } else {
          this.params.logger.debug?.(
            `${options.platform.logScope} browser readiness refresh ignored: ${formatErrorMessage(error)}`,
          );
        }
      }
    }

    async #captureTranscript(session: Session, captureOptions: { finalize?: boolean } = {}) {
      // Recovery permits caption setup but atomically refuses a different live
      // session owner, so stale sessions read their archived page buffer instead.
      await this.refreshCaptionHealth(session);
      const tab = session.chrome?.browserTab;
      if (!tab) {
        return undefined;
      }
      return await options.transport.readTranscript({
        runtime: this.params.runtime,
        config: this.params.config,
        finalize: captureOptions.finalize,
        meetingUrl: session.url,
        meetingSessionId: session.id,
        nodeId: session.chrome?.nodeId,
        tab,
      });
    }

    #withSessionAgentConfig(agentId: string): Config {
      return this.params.config.realtime.agentId === agentId
        ? this.params.config
        : {
            ...this.params.config,
            realtime: { ...this.params.config.realtime, agentId },
          };
    }

    #noteSession(session: Session, note: string): void {
      session.notes = [...session.notes.filter((item) => item !== note), note];
    }
  };
}
