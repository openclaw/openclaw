import { createHash, randomUUID } from "node:crypto";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { PluginStateStoreError } from "../plugin-state/plugin-state-store.types.js";
import type {
  MeetingParticipationAttempt,
  MeetingParticipationContext,
  MeetingParticipationOptions,
  MeetingParticipationRequest,
  MeetingParticipationResult,
  MeetingParticipationSource,
} from "./participation-types.js";

const SOURCE_LIFETIME_MS = 120_000;
const MAX_SOURCES = 1_024;

function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(canonical);
    }
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

type LiveSource = MeetingParticipationSource & {
  sourceId: string;
  order: number;
  replacesSourceId?: string;
  observedAt: number;
  assertOwnerCurrent: () => void;
};

/** The live session owns authority; persisted claims only prevent replay of that authority. */
export class MeetingParticipation<TSession> {
  readonly #closed = new Set<string>();
  readonly #orders = new Map<string, number>();
  readonly #identities = new Map<
    string,
    Map<
      string,
      {
        order: number;
        observedAt: number;
        assertOwnerCurrent: () => void;
        sourceId?: string;
        ownEcho?: boolean;
        revision?: string;
        seenRevisions: Set<string>;
      }
    >
  >();
  readonly #sources = new Map<string, Map<string, LiveSource>>();
  readonly #epochs = new Map<string, Map<string, { current: string; seen: Set<string> }>>();

  constructor(
    private readonly options: MeetingParticipationOptions<TSession> & {
      current(sessionId: string): { session: TSession; assertCurrent(): void } | undefined;
    },
  ) {}

  close(sessionId: string): void {
    this.#closed.add(sessionId);
    this.#sources.delete(sessionId);
    this.#identities.delete(sessionId);
    this.#epochs.delete(sessionId);
  }

  observeEpoch(
    sessionId: string,
    kind: MeetingParticipationSource["kind"],
    observedEpoch: string,
  ): boolean {
    if (this.#closed.has(sessionId) || !this.options.current(sessionId) || !observedEpoch) {
      return false;
    }
    let epochs = this.#epochs.get(sessionId);
    if (!epochs) {
      this.#epochs.set(sessionId, (epochs = new Map()));
    }
    const epoch = epochs.get(kind);
    if (epoch?.seen.has(observedEpoch) && epoch.current !== observedEpoch) {
      return false;
    }
    if (epoch) {
      epoch.current = observedEpoch;
      epoch.seen.add(observedEpoch);
    } else {
      epochs.set(kind, { current: observedEpoch, seen: new Set([observedEpoch]) });
    }
    // A new document invalidates old observations, including already issued references.
    const sources = this.#sources.get(sessionId);
    for (const [key, source] of sources ?? []) {
      if (source.kind === kind && source.epoch !== observedEpoch) {
        sources?.delete(key);
      }
    }
    return true;
  }

  observe(sessionId: string, source: MeetingParticipationSource): string | undefined {
    const current = this.#closed.has(sessionId) ? undefined : this.options.current(sessionId);
    if (!current) {
      return undefined;
    }
    if (!source.id || !this.observeEpoch(sessionId, source.kind, source.epoch)) {
      return undefined;
    }
    let sources = this.#sources.get(sessionId);
    if (!sources) {
      this.#sources.set(sessionId, (sources = new Map()));
    }
    for (const [key, existing] of sources) {
      if (Date.now() - existing.observedAt > SOURCE_LIFETIME_MS) {
        sources.delete(key);
      }
    }
    const key = fingerprint([source.kind, source.epoch, source.id]);
    const previous = sources.get(key);
    let identities = this.#identities.get(sessionId);
    if (!identities) {
      this.#identities.set(sessionId, (identities = new Map()));
    }
    let identity = identities.get(key);
    if (!identity) {
      if (identities.size >= 10_000) {
        return undefined;
      }
      const order = (this.#orders.get(sessionId) ?? 0) + 1;
      this.#orders.set(sessionId, order);
      identities.set(
        key,
        (identity = {
          order,
          observedAt: Date.now(),
          assertOwnerCurrent: current.assertCurrent.bind(current),
          seenRevisions: new Set(),
        }),
      );
    }
    identity.ownEcho ||= source.ownEcho;
    if (identity.ownEcho) {
      sources.delete(key);
      return undefined;
    }
    if (identity.seenRevisions.has(source.revision) && identity.revision !== source.revision) {
      return undefined;
    }
    identity.revision = source.revision;
    identity.seenRevisions.add(source.revision);
    if (identity.seenRevisions.size > 128) {
      sources.delete(key);
      return undefined;
    }
    try {
      identity.assertOwnerCurrent();
    } catch {
      sources.delete(key);
      return undefined;
    }
    if (Date.now() - identity.observedAt > SOURCE_LIFETIME_MS) {
      return undefined;
    }
    if (
      !source.finalized ||
      !source.revision ||
      !source.text?.trim() ||
      source.text.length > 16_384
    ) {
      sources.delete(key);
      return undefined;
    }
    if (previous?.revision === source.revision && previous.text === source.text) {
      return previous.sourceId;
    }
    let evictionKey: string | undefined;
    if (!previous && sources.size >= MAX_SOURCES) {
      // Replayed history must not displace newer live sources or invalidate their guards.
      let oldestOrder = identity.order;
      for (const [liveKey, liveSource] of sources) {
        if (liveSource.order < oldestOrder) {
          evictionKey = liveKey;
          oldestOrder = liveSource.order;
        }
      }
      if (evictionKey === undefined) {
        return undefined;
      }
    }
    const entry = {
      ...source,
      sourceId: randomUUID(),
      order: identity.order,
      ...(identity.sourceId ? { replacesSourceId: identity.sourceId } : {}),
      observedAt: identity.observedAt,
      assertOwnerCurrent: identity.assertOwnerCurrent,
    };
    identity.sourceId = entry.sourceId;
    sources.set(key, entry);
    if (evictionKey !== undefined) {
      sources.delete(evictionKey);
    }
    return entry.sourceId;
  }

  context(sessionId: string): MeetingParticipationContext {
    const current = this.#closed.has(sessionId) ? undefined : this.options.current(sessionId);
    return {
      sessionId,
      active: Boolean(current),
      sourceOrder: current ? (this.#orders.get(sessionId) ?? 0) : 0,
      capabilities: current ? [...this.options.capabilities(current.session)] : [],
      sources: current
        ? [...(this.#sources.get(sessionId)?.values() ?? [])]
            .filter((source) => this.#isSourceCurrent(source))
            .map(({ observedAt: _at, assertOwnerCurrent: _assert, ...source }) => source)
        : [],
    };
  }

  inspect(
    sessionId: string,
    sourceId: string,
  ):
    | {
        source: MeetingParticipationSource & {
          sourceId: string;
          order: number;
          replacesSourceId?: string;
        };
        assertCurrent(): void;
      }
    | undefined {
    const current = this.#closed.has(sessionId) ? undefined : this.options.current(sessionId);
    const source = this.#findSource(sessionId, sourceId);
    if (!current || !source) {
      return undefined;
    }
    const { observedAt: _at, assertOwnerCurrent: _assert, ...snapshot } = source;
    return {
      source: snapshot,
      assertCurrent: () => {
        if (this.#closed.has(sessionId) || this.#findSource(sessionId, sourceId) !== source) {
          throw new Error("The participation source is no longer current.");
        }
        current.assertCurrent();
      },
    };
  }

  async execute(
    sessionId: string,
    input: MeetingParticipationRequest,
  ): Promise<MeetingParticipationResult> {
    // Snapshot caller-owned arguments before any await; no later mutation can change the claim.
    const request = structuredClone(input);
    const result = (
      status: MeetingParticipationResult["status"],
      message: string,
    ): MeetingParticipationResult => ({ requestId: request.requestId, status, message });
    // Claims store only these bounded scalar fields plus a hash. A store LIMIT_EXCEEDED
    // can therefore mean row capacity here, never an oversized/deep claim payload.
    const validToken = (value: unknown): value is string =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      Buffer.byteLength(value, "utf8") <= 128;
    if (
      !validToken(sessionId) ||
      !validToken(request.requestId) ||
      !request.action ||
      !validToken(request.action.type) ||
      (request.sourceId !== undefined && !validToken(request.sourceId)) ||
      (request.correctionOf !== undefined && !validToken(request.correctionOf))
    ) {
      return result(
        "rejected",
        "Session, request, action, and source identifiers must be non-empty strings of at most 128 UTF-8 bytes.",
      );
    }
    const store = this.options.store;
    const key = `${sessionId}:request:${request.requestId}`;
    const digest = fingerprint(request);
    const replay = (prior: MeetingParticipationAttempt | undefined): MeetingParticipationResult => {
      if (prior?.fingerprint !== digest) {
        return result("rejected", "This requestId already identifies a different action.");
      }
      return {
        ...(prior.result ??
          result(
            "uncertain",
            "This action was already claimed; its result is unknown. Do not retry it.",
          )),
        replayed: true,
      };
    };
    const prior = await store.lookup(key);
    if (prior) {
      return replay(prior);
    }
    const current = this.#closed.has(sessionId) ? undefined : this.options.current(sessionId);
    if (!current) {
      return result("rejected", "The meeting session is no longer active.");
    }
    const source = request.sourceId ? this.#findSource(sessionId, request.sourceId) : undefined;
    let capabilityAdmitted = false;
    const assertCurrent = () => {
      if (this.#closed.has(sessionId)) {
        throw new Error("The meeting session is closing.");
      }
      current.assertCurrent();
      if (
        capabilityAdmitted &&
        !this.options.capabilities(current.session).includes(request.action.type)
      ) {
        throw new Error("The participation capability is no longer available.");
      }
      if (
        request.sourceId &&
        (!source || this.#findSource(sessionId, request.sourceId) !== source)
      ) {
        throw new Error("The participation source is stale, corrected, expired, or an own echo.");
      }
    };
    const attempt: MeetingParticipationAttempt = {
      kind: "meeting-participation-attempt",
      sessionId,
      requestId: request.requestId,
      fingerprint: digest,
      ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
      actionType: request.action.type,
      ...(request.correctionOf === undefined ? {} : { correctionOf: request.correctionOf }),
    };
    const claimed = await this.#claim(key, attempt);
    if (!claimed) {
      return replay(await store.lookup(key));
    }
    const finish = async (
      outcome: MeetingParticipationResult,
    ): Promise<MeetingParticipationResult> => {
      try {
        await store.register(key, { ...attempt, result: outcome });
      } catch {
        return result(
          "uncertain",
          "The action result could not be recorded. Its claim remains; do not retry it.",
        );
      }
      return outcome;
    };
    try {
      assertCurrent();
      if (request.correctionOf) {
        const original = await store.lookup(`${sessionId}:request:${request.correctionOf}`);
        assertCurrent();
        if (
          !original ||
          original.correctionOf ||
          original.result?.correctionOf !== request.correctionOf ||
          original.sourceId !== request.sourceId ||
          original.actionType !== request.action.type
        ) {
          return await finish(
            result(
              "rejected",
              "The correction must retain a correctable request's source and action type.",
            ),
          );
        }
        const correctionClaimed = await this.#claim(
          `${sessionId}:correction:${request.correctionOf}`,
          attempt,
        );
        assertCurrent();
        if (!correctionClaimed) {
          return await finish(
            result("rejected", "This request already used its one correction opportunity."),
          );
        }
      }
      if (!this.options.capabilities(current.session).includes(request.action.type)) {
        return await finish(
          result("unsupported", "This meeting does not support that participation action."),
        );
      }
      capabilityAdmitted = true;
      if (source) {
        const sourceKey = `${sessionId}:source:${fingerprint([source.kind, source.epoch, source.id, request.action.type])}`;
        const sourceClaimed = await this.#claim(sourceKey, attempt);
        assertCurrent();
        if (!sourceClaimed) {
          const original = await store.lookup(sourceKey);
          assertCurrent();
          if (
            !request.correctionOf ||
            original?.requestId !== request.correctionOf ||
            original.sourceId !== request.sourceId
          ) {
            return await finish(
              result(
                "rejected",
                "This source already authorized this action type; it cannot authorize another attempt.",
              ),
            );
          }
        }
      }
      const validation = this.options.validateAction(request.action);
      if (validation) {
        return await finish({
          ...result("rejected", validation),
          ...(!request.correctionOf ? { correctionOf: request.requestId } : {}),
        });
      }
      assertCurrent();
    } catch (error) {
      return await finish(result("rejected", coerceErrorMessage(error)));
    }
    let outcome: MeetingParticipationResult;
    try {
      assertCurrent();
      const { correctable, ...effect } = await this.options.execute(
        current.session,
        request,
        assertCurrent,
      );
      assertCurrent();
      outcome = {
        status: effect.status,
        ...(effect.message === undefined ? {} : { message: effect.message }),
        ...(effect.observed === undefined ? {} : { observed: effect.observed }),
        requestId: request.requestId,
        ...(effect.status === "rejected" && correctable === true && !request.correctionOf
          ? { correctionOf: request.requestId }
          : {}),
      };
    } catch (error) {
      outcome = result(
        "uncertain",
        `The action outcome is unknown: ${coerceErrorMessage(error)}. Do not retry it.`,
      );
    }
    return await finish(outcome);
  }

  async #claim(key: string, attempt: MeetingParticipationAttempt): Promise<boolean> {
    try {
      return await this.options.store.registerIfAbsent(key, attempt);
    } catch (error) {
      // A known capacity rejection precedes any insertion. Never retry uncertain writes.
      if (
        !(error instanceof PluginStateStoreError) ||
        error.code !== "PLUGIN_STATE_LIMIT_EXCEEDED"
      ) {
        throw error;
      }
      const entries = await this.options.store.entries();
      let removed = 0;
      for (const entry of entries.toSorted((a, b) => a.createdAt - b.createdAt)) {
        const value = entry.value;
        if (
          !value ||
          value.kind !== "meeting-participation-attempt" ||
          typeof value.sessionId !== "string" ||
          !value.sessionId ||
          typeof value.requestId !== "string"
        ) {
          continue;
        }
        const knownKey =
          entry.key === `${value.sessionId}:request:${value.requestId}` ||
          (value.correctionOf &&
            entry.key === `${value.sessionId}:correction:${value.correctionOf}`) ||
          (entry.key.startsWith(`${value.sessionId}:source:`) &&
            /^[a-f0-9]{64}$/.test(entry.key.slice(`${value.sessionId}:source:`.length)));
        if (!knownKey) {
          continue;
        }
        if (!this.#closed.has(value.sessionId) && this.options.current(value.sessionId)) {
          continue;
        }
        if (await this.options.store.delete(entry.key)) {
          removed++;
        }
        if (removed >= 1_000) {
          break;
        }
      }
      // Another claimant may have reclaimed the same rows. Atomic admission, not
      // this sweep's deletion count, decides whether capacity is still exhausted.
      return await this.options.store.registerIfAbsent(key, attempt);
    }
  }

  #findSource(sessionId: string, sourceId: string): LiveSource | undefined {
    for (const source of this.#sources.get(sessionId)?.values() ?? []) {
      if (source.sourceId === sourceId && this.#isSourceCurrent(source)) {
        return source;
      }
    }
    return undefined;
  }

  #isSourceCurrent(source: LiveSource): boolean {
    if (Date.now() - source.observedAt > SOURCE_LIFETIME_MS) {
      return false;
    }
    try {
      source.assertOwnerCurrent();
      return true;
    } catch {
      return false;
    }
  }
}
