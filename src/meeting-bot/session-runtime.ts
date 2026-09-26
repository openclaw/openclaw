import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import type {
  TranscriptStartRequest,
  TranscriptsStartResult,
  TranscriptStopRequest,
  TranscriptsStopResult,
} from "../transcripts/provider-types.js";
import {
  meetingCaptionParticipationSources,
  snapshotMeetingObservation,
  snapshotMeetingTranscript,
} from "./observation-provenance.js";
import type {
  MeetingParticipationRequest,
  MeetingParticipationSource,
} from "./participation-types.js";
import { MeetingParticipation } from "./participation.js";
import { MeetingSessionCleanupTracker } from "./session-cleanup-tracker.js";
import { MeetingSessionDurableTranscripts } from "./session-durable-transcripts.js";
import {
  inheritMeetingBrowserTabOwnership,
  settleMeetingRetainedBrowserTabs,
  settleMeetingRetainedBrowserTabsAfterFailure,
} from "./session-runtime-browser-tabs.js";
import type {
  MeetingSessionLeaveResult,
  MeetingSessionRuntimeHandles,
  MeetingSessionRuntimeOptions,
} from "./session-runtime-types.js";
import { evaluateMeetingSpeechReadiness } from "./session-speech-readiness.js";
import { MeetingSessionTranscriptStore } from "./session-transcript-store.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingResolvedJoin,
  MeetingSessionRecord,
} from "./session-types.js";
export type {
  MeetingSessionLeaveResult,
  MeetingSessionRuntimeMessages,
  MeetingSessionRuntimeOptions,
  MeetingBrowserSessionView,
  MeetingSessionRuntimeHandles,
  MeetingSessionRuntimeJoinContext,
} from "./session-runtime-types.js";

const nowIso = () => new Date().toISOString();

/** Shared lifecycle owner; platform strategies perform transport-specific I/O only. */
export class MeetingSessionRuntime<
  TSession extends MeetingSessionRecord<TTransport, TMode>,
  TRequest,
  TTransport extends string,
  TMode extends string,
  THealth extends MeetingBrowserHealth<TManualReason, TSpeechBlockedReason>,
  TTab extends MeetingBrowserTab,
  TManualReason extends string,
  TSpeechBlockedReason extends string,
> {
  readonly #sessions = new Map<string, TSession>();
  readonly #participation?: MeetingParticipation<TSession>;
  readonly #sessionLeaves = new Map<string, Promise<MeetingSessionLeaveResult<TSession>>>();
  readonly #sessionCleanup = new MeetingSessionCleanupTracker();
  readonly #meetingLock = new KeyedAsyncQueue();
  readonly #sessionSpeakers = new Map<string, (instructions?: string) => void>();
  readonly #sessionHealth = new Map<string, () => Partial<THealth>>();
  readonly #durableTranscripts: MeetingSessionDurableTranscripts<TSession>;
  readonly #transcriptStore: MeetingSessionTranscriptStore<TSession>;

  constructor(
    private readonly options: MeetingSessionRuntimeOptions<
      TSession,
      TRequest,
      TTransport,
      TMode,
      THealth,
      TTab,
      TManualReason,
      TSpeechBlockedReason
    >,
  ) {
    if (options.participation) {
      this.#participation = new MeetingParticipation({
        ...options.participation,
        current: (sessionId) => {
          const session = this.#sessions.get(sessionId);
          if (!session) {
            return undefined;
          }
          const isCurrent = this.#captureSessionOwnership(session);
          if (session.state !== "active") {
            return undefined;
          }
          return {
            session,
            assertCurrent: () => {
              if (!isCurrent(sessionId)) {
                throw new Error("The meeting session no longer owns this browser tab and route.");
              }
            },
          };
        },
      });
    }
    this.#transcriptStore = new MeetingSessionTranscriptStore({
      getSession: (sessionId) => this.#sessions.get(sessionId),
      isBrowserSession: (session) => this.options.isBrowserTransport(session.transport),
      isTranscribeSession: (session) => this.options.isTranscribeMode(session.mode),
      hasBrowserTab: (session) => Boolean(this.options.getBrowser(session)?.tab),
      capture: async (session, captureOptions) => {
        const isCurrent = this.#captureSessionOwnership(session, {
          requireSameTab: this.#participation !== undefined,
        });
        const snapshot = await this.options.captureTranscript(session, captureOptions);
        if (!isCurrent(session.id)) {
          throw new Error("The meeting session no longer owns the captured browser tab and route.");
        }
        return snapshot && snapshotMeetingTranscript(snapshot);
      },
      onSnapshot: (session, snapshot) => {
        if (
          snapshot.epoch &&
          this.#participation?.observeEpoch(session.id, "caption", snapshot.epoch) === false
        ) {
          return;
        }
        for (const source of meetingCaptionParticipationSources(snapshot)) {
          this.observeParticipationSource(session.id, source);
        }
      },
      onLines: async (session, lines) => await this.#durableTranscripts.ingest(session, lines),
    });
    this.#durableTranscripts = new MeetingSessionDurableTranscripts({
      config: options.durableTranscripts,
      formatError: (error) => options.formatError(error),
      isBrowserSession: (session) => options.isBrowserTransport(session.transport),
      isTranscribeSession: (session) => options.isTranscribeMode(session.mode),
      listSessions: () => [...this.#sessions.values()],
      logger: options.logger,
      logScope: options.logScope,
      sameMeetingUrl: (left, right) => options.sameMeetingUrl(left, right),
      transcriptStore: this.#transcriptStore,
    });
  }

  list(): TSession[] {
    this.refreshHealth();
    return [...this.#sessions.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getSession(sessionId: string): TSession | undefined {
    return this.#sessions.get(sessionId);
  }

  async status(sessionId?: string): Promise<{
    found: boolean;
    session?: TSession;
    sessions?: TSession[];
  }> {
    this.refreshHealth(sessionId);
    if (!sessionId) {
      const sessions = [...this.#sessions.values()].toSorted((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      await Promise.all(sessions.map((session) => this.options.refreshStatus(session)));
      return { found: true, sessions };
    }
    const session = this.#sessions.get(sessionId);
    if (session) {
      await this.options.refreshStatus(session);
    }
    return session ? { found: true, session } : { found: false };
  }

  participationContext(sessionId: string) {
    const context = this.#participation?.context(sessionId) ?? {
      sessionId,
      active: false,
      sourceOrder: 0,
      capabilities: [],
      sources: [],
    };
    return { ...context, sources: context.sources.map(snapshotMeetingObservation) };
  }

  observeParticipationEpoch(
    sessionId: string,
    kind: MeetingParticipationSource["kind"],
    epoch: string,
  ): boolean {
    return this.#participation?.observeEpoch(sessionId, kind, epoch) ?? false;
  }

  observeParticipationSource(
    sessionId: string,
    source: MeetingParticipationSource,
  ): string | undefined {
    return this.#participation?.observe(sessionId, snapshotMeetingObservation(source));
  }

  inspectParticipationSource(sessionId: string, sourceId: string) {
    const inspected = this.#participation?.inspect(sessionId, sourceId);
    return inspected && { ...inspected, source: snapshotMeetingObservation(inspected.source) };
  }

  async participate(sessionId: string, request: MeetingParticipationRequest) {
    return this.#participation
      ? await this.#participation.execute(sessionId, request)
      : {
          requestId: request.requestId,
          status: "unsupported" as const,
          message: "This meeting platform does not support participation actions.",
        };
  }

  async transcript(sessionId: string, options: { sinceIndex?: number } = {}) {
    return snapshotMeetingTranscript(await this.#transcriptStore.read(sessionId, options));
  }

  async startTranscriptSource(request: TranscriptStartRequest): Promise<TranscriptsStartResult> {
    return await this.#durableTranscripts.startSource(request);
  }

  reconcileTranscriptPolicy(enabled: boolean): Promise<void> {
    return this.#durableTranscripts.reconcilePolicy(enabled);
  }

  async stopTranscriptSource(request: TranscriptStopRequest): Promise<TranscriptsStopResult> {
    return await this.#durableTranscripts.stopSource(request);
  }

  isReusableSession(session: TSession, resolved: MeetingResolvedJoin<TTransport, TMode>): boolean {
    return (
      session.state === "active" &&
      this.options.sameMeetingUrl(session.url, resolved.url) &&
      session.transport === resolved.transport &&
      session.mode === resolved.mode &&
      session.agentId === resolved.agentId
    );
  }

  async join(request: TRequest): Promise<{ session: TSession; spoken?: boolean }> {
    const resolved = this.options.resolveJoin(request);
    // Session publication follows async transport setup. Serialize every transport so
    // concurrent identical joins cannot both create an external participant.
    return await this.#meetingLock.enqueue(
      this.#meetingKey(resolved.transport, resolved.url),
      async () => await this.#joinUnlocked(request, resolved),
    );
  }

  async leave(
    sessionId: string,
    options?: { keepBrowserTab?: boolean },
  ): Promise<MeetingSessionLeaveResult<TSession>> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false };
    }
    this.#participation?.close(sessionId);
    // The meeting lock fences joins and leaves before terminal transcript work;
    // #sessionLeaves then coalesces retries owned by the same session.
    return await this.#meetingLock.enqueue(
      this.#meetingKey(session.transport, session.url),
      async () => await this.#leaveUnlocked(sessionId, options),
    );
  }

  async speak(
    sessionId: string,
    instructions?: string,
  ): Promise<{ found: boolean; spoken: boolean; session?: TSession }> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false, spoken: false };
    }
    if (session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    const delegated = await this.options.speakViaTransport(session, instructions);
    if (session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    if (delegated?.handled) {
      return { found: true, spoken: delegated.spoken, session };
    }
    await this.refreshBrowserHealth(session);
    if (session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    await this.#sessionCleanup.prepareRuntime(session.id, async () => {
      if (session.state !== "active") {
        return;
      }
      const handles = await this.options.ensureRealtimeBridge(session);
      if (handles) {
        this.#attachRuntimeHandles(session, handles);
      }
    });
    if (session.state !== "active") {
      await this.#sessionCleanup.stopRuntime(session.id);
      return { found: true, spoken: false, session };
    }
    const speak = this.#sessionSpeakers.get(sessionId);
    if (!speak || session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    const readiness = this.refreshSpeechReadiness(session);
    if (!readiness.ready) {
      const note = readiness.message
        ? `Realtime speech blocked: ${readiness.message}`
        : this.options.messages.speechBlockedFallback;
      this.#noteSession(session, note);
      session.updatedAt = nowIso();
      return { found: true, spoken: false, session };
    }
    speak(instructions || this.options.defaultSpeechInstructions);
    session.updatedAt = nowIso();
    this.refreshHealth(sessionId);
    return { found: true, spoken: true, session };
  }

  async speakWhenReady(session: TSession, instructions: string): Promise<boolean> {
    let result = await this.speak(session.id, instructions);
    if (result.spoken || !this.options.isBrowserTransport(session.transport)) {
      return result.spoken;
    }
    const waitMs = Math.min(
      Math.max(0, this.options.waitForInCallMs),
      Math.max(0, this.options.joinTimeoutMs),
    );
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())));
      });
      result = await this.speak(session.id, instructions);
      if (result.spoken) {
        return true;
      }
      const health = this.options.getBrowser(result.session as TSession)?.health;
      if (health?.manualAction || result.session?.state !== "active") {
        return false;
      }
      const blocked = health?.speechBlockedReason;
      if (blocked && !this.options.transientSpeechBlockedReasons.has(blocked)) {
        return false;
      }
    }
    return false;
  }

  hasHealthHandle(sessionId: string): boolean {
    return this.#sessionHealth.has(sessionId);
  }

  refreshHealth(sessionId?: string): void {
    const ids = sessionId ? [sessionId] : [...this.#sessionHealth.keys()];
    for (const id of ids) {
      const session = this.#sessions.get(id);
      const getHealth = this.#sessionHealth.get(id);
      const browser = session ? this.options.getBrowser(session) : undefined;
      if (!session || !browser || !getHealth) {
        continue;
      }
      this.options.setBrowserHealth(session, { ...browser.health, ...getHealth() } as THealth);
      this.refreshSpeechReadiness(session);
    }
  }

  async refreshBrowserHealth(
    session: TSession,
    options: { force?: boolean; readOnly?: boolean } = {},
  ): Promise<void> {
    if (!this.#isManagedBrowserSession(session)) {
      this.refreshSpeechReadiness(session);
      return;
    }
    if (
      !options.force &&
      this.options.isTalkBackMode(session.mode) &&
      this.#evaluateSpeechReadiness(session).ready
    ) {
      this.refreshSpeechReadiness(session);
      return;
    }
    await this.options.refreshBrowserHealth(session, options);
    this.refreshSpeechReadiness(session);
  }

  async refreshCaptionHealth(session: TSession): Promise<void> {
    if (!this.options.isTranscribeMode(session.mode)) {
      this.refreshSpeechReadiness(session);
      return;
    }
    await this.refreshBrowserHealth(session);
  }

  refreshSpeechReadiness(session: TSession): {
    ready: boolean;
    reason?: TSpeechBlockedReason;
    message?: string;
  } {
    const readiness = this.#evaluateSpeechReadiness(session);
    if (readiness.ready) {
      session.notes = session.notes.filter((note) => !note.startsWith("Realtime speech blocked:"));
    }
    const browser = this.options.getBrowser(session);
    if (browser) {
      this.options.setBrowserHealth(session, {
        ...browser.health,
        speechReady: readiness.ready,
        speechBlockedReason: readiness.reason,
        speechBlockedMessage: readiness.message,
      } as THealth);
    }
    return readiness;
  }

  markSessionEnded(session: TSession, reason: string): void {
    this.#participation?.close(session.id);
    session.state = "ended";
    session.updatedAt = nowIso();
    this.#dropRuntimeHandles(session.id);
    this.#noteSession(session, reason);
  }

  #captureSessionOwnership(
    session: TSession,
    { requireSameTab = true }: { requireSameTab?: boolean } = {},
  ): (sessionId: string) => boolean {
    const browser = this.options.getBrowser(session);
    const targetId = browser?.tab?.targetId;
    const nodeId = browser?.nodeId;
    // Transcript finalization can capture an ended session; preserve the state at capture.
    const { url, transport, state } = session;
    return (sessionId) => {
      const latest = this.options.getBrowser(session);
      return (
        this.#sessions.get(sessionId) === session &&
        session.state === state &&
        session.url === url &&
        session.transport === transport &&
        latest?.nodeId === nodeId &&
        (!requireSameTab || latest?.tab?.targetId === targetId)
      );
    };
  }

  async #joinUnlocked(
    request: TRequest,
    resolved: MeetingResolvedJoin<TTransport, TMode>,
  ): Promise<{ session: TSession; spoken?: boolean }> {
    for (const session of this.list()) {
      if (
        session.state === "ended" &&
        session.transport === resolved.transport &&
        this.options.sameMeetingUrl(session.url, resolved.url) &&
        this.#sessionCleanup.hasRuntime(session.id)
      ) {
        await this.#leaveUnlocked(session.id);
      }
    }
    const activeSessions = this.list().filter(
      (session) =>
        session.state === "active" &&
        this.options.sameMeetingUrl(session.url, resolved.url) &&
        session.transport === resolved.transport,
    );
    const retained: Array<{ session: TSession; tab: TTab }> = [];
    if (this.options.isBrowserTransport(resolved.transport)) {
      // A reused browser tab has one lifecycle owner. End every incompatible record
      // before adoption so leaving an older session cannot tear down the new one.
      for (const session of activeSessions) {
        if (this.isReusableSession(session, resolved)) {
          continue;
        }
        const browser = this.options.getBrowser(session);
        const tab = this.options.reuseExistingBrowserTab ? browser?.tab : undefined;
        const keepBrowserParticipant = Boolean(tab) || browser?.launched === false;
        if (tab) {
          retained.push({ session, tab });
        }
        try {
          const left = await this.#leaveUnlocked(
            session.id,
            keepBrowserParticipant ? { keepBrowserTab: true } : undefined,
          );
          if (left.browserLeft === false) {
            throw new Error(this.options.messages.previousBrowserLeaveFailed);
          }
        } catch (error) {
          await settleMeetingRetainedBrowserTabsAfterFailure(this.options, retained);
          throw error;
        }
        this.#noteSession(session, this.options.messages.reassignedSessionNote);
      }
    }
    let reusable = activeSessions.find((session) => this.isReusableSession(session, resolved));
    if (reusable) {
      const refreshResult = await this.options.refreshReusableSession(reusable, request, resolved);
      if (reusable.state !== "active") {
        // The refresh hook runs inside the join lock, so it marks stale sessions
        // ended and lets this owner perform cleanup without recursive lock entry.
        await this.#leaveSession(reusable, {
          keepBrowserTab: refreshResult?.keepBrowserTab ?? true,
        });
        reusable = undefined;
      }
    }
    const speechInstructions = this.options.resolveSpeechInstructions(request);
    if (reusable) {
      await this.#durableTranscripts.start(reusable);
      await this.refreshBrowserHealth(reusable);
      this.#noteSession(reusable, this.options.messages.reusedSessionNote);
      reusable.updatedAt = nowIso();
      const spoken =
        this.options.isTalkBackMode(resolved.mode) && speechInstructions
          ? await this.speakWhenReady(reusable, speechInstructions)
          : false;
      return { session: reusable, spoken };
    }

    const session = this.options.createSession({ request, resolved, createdAt: nowIso() });
    let delegatedSpoken: boolean;
    try {
      const result = await this.options.joinTransport({
        request,
        session,
        context: {
          attachRuntimeHandles: (target, handles) => this.#attachRuntimeHandles(target, handles),
          inheritedBrowserTab: (params) =>
            inheritMeetingBrowserTabOwnership(this.#sessions.values(), this.options, params),
        },
      });
      delegatedSpoken = result.delegatedSpoken === true;
      const browser = this.options.getBrowser(session);
      const settled = await settleMeetingRetainedBrowserTabs(
        this.options,
        retained,
        browser?.tab
          ? { transport: session.transport, nodeId: browser.nodeId, tab: browser.tab }
          : undefined,
      );
      if (!settled) {
        throw new Error(this.options.messages.replacementBrowserLeaveFailed);
      }
    } catch (error) {
      // Complete rollback now; keep only unfinished cleanup reachable for a later leave.
      await this.#rollbackFailedJoinSession(session);
      if (this.#sessionCleanup.isPending(session.id)) {
        this.#sessionCleanup.retainFailedJoin(session.id);
        this.#sessions.set(session.id, session);
        this.#noteSession(session, "Meeting cleanup is pending; use leave to retry.");
      }
      await settleMeetingRetainedBrowserTabsAfterFailure(this.options, retained);
      this.options.logger.warn(
        `${this.options.logScope} join failed: ${this.options.formatError(error)}`,
      );
      throw error;
    }

    this.#sessions.set(session.id, session);
    await this.#durableTranscripts.start(session);
    const spoken = delegatedSpoken
      ? true
      : this.options.isTalkBackMode(resolved.mode) && speechInstructions
        ? await this.speakWhenReady(session, speechInstructions)
        : false;
    return { session, spoken };
  }

  async #leaveUnlocked(
    sessionId: string,
    options?: { keepBrowserTab?: boolean },
  ): Promise<MeetingSessionLeaveResult<TSession>> {
    const inFlight = this.#sessionLeaves.get(sessionId);
    if (inFlight) {
      return await inFlight;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false };
    }
    if (
      session.state === "ended" &&
      !this.#sessionCleanup.isPending(sessionId) &&
      !this.#sessionCleanup.hasRuntime(sessionId)
    ) {
      return {
        found: true,
        session,
        ...(session.browserLeft === undefined ? {} : { browserLeft: session.browserLeft }),
      };
    }
    const leave = this.#leaveSession(session, options);
    this.#sessionLeaves.set(sessionId, leave);
    try {
      return await leave;
    } finally {
      if (this.#sessionLeaves.get(sessionId) === leave) {
        this.#sessionLeaves.delete(sessionId);
      }
    }
  }

  async #leaveSession(
    session: TSession,
    options?: { keepBrowserTab?: boolean },
  ): Promise<MeetingSessionLeaveResult<TSession>> {
    this.#participation?.close(session.id);
    const firstAttempt = this.#sessionCleanup.begin(session.id, session.browserLeft);
    session.state = "ended";
    session.updatedAt = nowIso();
    this.#dropRuntimeHandles(session.id);
    const transcribe = this.options.isTranscribeMode(session.mode);
    let transcriptStopped = false;
    if (transcribe) {
      // Fence new live reads before final capture; the store's capture chain drains
      // reads already admitted before this terminal boundary.
      this.#transcriptStore.startFinalizing(session.id);
    }
    try {
      transcriptStopped = await this.#durableTranscripts.stop(session, {
        allowFallback: firstAttempt,
      });
      const cleanup = await this.#sessionCleanup.cleanup({
        sessionId: session.id,
        keepBrowserTab: options?.keepBrowserTab === true,
        hasBrowserTab: () => Boolean(this.options.getBrowser(session)?.tab),
        releaseBrowser: async () => await this.options.releaseBrowserTab(session),
      });
      session.browserLeft = cleanup.browserLeft;
      const browser = this.options.getBrowser(session);
      if (cleanup.browserLeft === true && browser?.health) {
        this.options.setBrowserHealth(session, {
          ...browser.health,
          inCall: false,
          micMuted: undefined,
          manualAction: undefined,
          speechReady: false,
          speechBlockedReason: undefined,
          speechBlockedMessage: undefined,
        } as THealth);
      }
      if (cleanup.complete) {
        this.#dropRuntimeHandles(session.id);
        if (cleanup.unpublished) {
          this.#sessions.delete(session.id);
        }
      }
      return {
        found: true,
        session,
        ...(cleanup.browserLeft === undefined ? {} : { browserLeft: cleanup.browserLeft }),
      };
    } finally {
      if (transcriptStopped) {
        this.#transcriptStore.retire(session.id);
      }
      if (transcribe) {
        this.#transcriptStore.finishFinalizing(session.id);
      }
    }
  }

  #meetingKey(transport: TTransport, url: string): string {
    const meeting = this.options.normalizeMeetingUrlForReuse(url) ?? url;
    return `${transport}:${meeting}`;
  }

  async #rollbackFailedJoinSession(session: TSession): Promise<void> {
    await this.#sessionCleanup.rollbackFailedJoin({
      sessionId: session.id,
      browserLeft: session.browserLeft,
      leave: async () => await this.#leaveSession(session),
      hasBrowserTab: () => Boolean(this.options.getBrowser(session)?.tab),
      releaseBrowser: async () => await this.options.releaseBrowserTab(session),
      formatError: (error) => this.options.formatError(error),
      warn: (message) => this.options.logger.warn(`${this.options.logScope} ${message}`),
      onBrowserResult: (left) => (session.browserLeft = left),
      onComplete: () => this.#dropRuntimeHandles(session.id),
    });
  }

  #attachRuntimeHandles(session: TSession, handles: MeetingSessionRuntimeHandles<THealth>): void {
    if (handles.stop) {
      this.#sessionCleanup.addStop(session.id, handles.stop);
    }
    if (session.state !== "active") {
      return;
    }
    if (handles.speak) {
      this.#sessionSpeakers.set(session.id, handles.speak);
    }
    if (handles.getHealth) {
      this.#sessionHealth.set(session.id, handles.getHealth);
    }
  }

  #dropRuntimeHandles(sessionId: string): void {
    this.#sessionSpeakers.delete(sessionId);
    this.#sessionHealth.delete(sessionId);
  }

  #isManagedBrowserSession(session: TSession): boolean {
    const browser = this.options.getBrowser(session);
    return Boolean(this.options.isBrowserTransport(session.transport) && browser?.launched);
  }

  #evaluateSpeechReadiness(session: TSession): {
    ready: boolean;
    reason?: TSpeechBlockedReason;
    message?: string;
  } {
    return evaluateMeetingSpeechReadiness({
      browser: this.options.getBrowser(session),
      managedBrowser: this.#isManagedBrowserSession(session),
      speech: this.options.messages.speech,
      talkBack: this.options.isTalkBackMode(session.mode),
    });
  }

  #noteSession(session: TSession, note: string): void {
    session.notes = [...session.notes.filter((item) => item !== note), note];
  }
}
