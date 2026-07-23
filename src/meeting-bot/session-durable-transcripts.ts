import type { RuntimeLogger } from "../plugins/runtime/types.js";
import type {
  TranscriptSourceLocator,
  TranscriptStartRequest,
  TranscriptsStartResult,
  TranscriptStopRequest,
  TranscriptsStopResult,
} from "../transcripts/provider-types.js";
import { MeetingSessionTranscriptStore } from "./session-transcript-store.js";
import type { MeetingSessionRecord, MeetingTranscriptLine } from "./session-types.js";
import type {
  MeetingDurableTranscriptBridge,
  MeetingDurableTranscriptsOptions,
} from "./transcripts-bridge.js";

export class MeetingSessionDurableTranscripts<TSession extends MeetingSessionRecord> {
  #bridge?: Promise<MeetingDurableTranscriptBridge<TSession> | undefined>;

  constructor(
    private readonly options: {
      config: MeetingDurableTranscriptsOptions | undefined;
      formatError(error: unknown): string;
      isBrowserSession(session: TSession): boolean;
      isTranscribeSession(session: TSession): boolean;
      listSessions(): TSession[];
      logger: RuntimeLogger;
      logScope: string;
      sameMeetingUrl(left: string | undefined, right: string | undefined): boolean;
      transcriptStore: MeetingSessionTranscriptStore<TSession>;
    },
  ) {}

  async ingest(session: TSession, lines: MeetingTranscriptLine[]): Promise<void> {
    await (await this.#getBridge())?.ingest(session, lines);
  }

  async start(session: TSession): Promise<void> {
    if (!this.options.isBrowserSession(session)) {
      return;
    }
    const bridge = await this.#getBridge();
    await bridge?.start(
      session,
      async () => await this.options.transcriptStore.captureNotes(session),
    );
  }

  async stop(session: TSession, options: { allowFallback: boolean }): Promise<void> {
    const finalCapture = async () =>
      await this.options.transcriptStore.captureNotes(session, { finalize: true });
    const bridge = await this.#getBridge();
    if (bridge?.enabled && (await bridge.stop(session, finalCapture))) {
      return;
    }
    if (options.allowFallback && this.options.isTranscribeSession(session)) {
      await finalCapture().catch((error: unknown) => {
        this.options.logger.debug?.(
          `${this.options.logScope} final transcript snapshot ignored: ${this.options.formatError(error)}`,
        );
      });
    }
  }

  async startSource(request: TranscriptStartRequest): Promise<TranscriptsStartResult> {
    const bridge = await this.#getBridge();
    if (!bridge?.enabled) {
      return { ok: false, error: "meeting transcripts are disabled" };
    }
    const session = this.#findSourceSession(request.session.source);
    if (!session) {
      return { ok: false, error: "No active meeting session matches the transcript source." };
    }
    if (request.session.source.agentId !== session.agentId) {
      return { ok: false, error: "meeting transcript source belongs to another agent" };
    }
    return await bridge.attach(session, request);
  }

  async stopSource(request: TranscriptStopRequest): Promise<TranscriptsStopResult> {
    const bridge = await this.#getBridge();
    return bridge
      ? await bridge.detach(request)
      : { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
  }

  #findSourceSession(source: TranscriptSourceLocator): TSession | undefined {
    const agentId = source.agentId?.trim();
    const meetingUrl = source.meetingUrl?.trim();
    const sessionId = source.channelId?.trim();
    if (!agentId || (!meetingUrl && !sessionId)) {
      return undefined;
    }
    return this.options
      .listSessions()
      .filter((session) => session.state === "active")
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .find(
        (session) =>
          session.agentId === agentId &&
          (!sessionId || session.id === sessionId) &&
          (!meetingUrl || this.options.sameMeetingUrl(session.url, meetingUrl)),
      );
  }

  async #getBridge(): Promise<MeetingDurableTranscriptBridge<TSession> | undefined> {
    if (!this.options.config) {
      return undefined;
    }
    this.#bridge ??= import("./transcripts-bridge.runtime.js")
      .then(({ createMeetingDurableTranscriptBridge }) =>
        createMeetingDurableTranscriptBridge<TSession>({
          logger: this.options.logger,
          options: this.options.config!,
        }),
      )
      .catch((error: unknown) => {
        this.options.logger.warn(
          `${this.options.logScope} durable transcripts unavailable: ${this.options.formatError(error)}`,
        );
        return undefined;
      });
    return await this.#bridge;
  }
}
