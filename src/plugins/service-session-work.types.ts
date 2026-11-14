/** One current execution borrow, issued by the host for live or previously accepted work. */
export type PluginServiceSessionWorkContextV1 = {
  readonly target: Readonly<{
    agentId: string;
    sessionKey: string;
    sessionId: string;
    lifecycleRevision?: string;
  }>;
  readonly signal: AbortSignal;
  assertCurrent: () => void;
};

/** Durable admission is host-owned. IDs and plugin state are not credentials. */
export type PluginServiceSessionWorkV1 = {
  readonly version: 1;
  /** Borrow the original live invocation's current target without accepting work or
   * writing an admission. Retained contexts fail after the callback settles.
   */
  withCurrent: <T>(
    input: { agentId: string; sessionKey: string; toolName: string },
    work: (context: PluginServiceSessionWorkContextV1) => Promise<T>,
  ) => Promise<T>;
  /** Called within the original live invocation, before accepting external work.
   * Requested tools are checked against that invocation and current session policy;
   * they restrict later effects, never expand the caller's executable surface.
   */
  admit: (input: {
    id: string;
    agentId: string;
    sessionKey: string;
    toolName: string;
    delegatedTools?: readonly string[];
  }) => Promise<{ recoverable: boolean; target: PluginServiceSessionWorkContextV1["target"] }>;
  /** Reauthorize the exact accepted source. Unavailable authority produces no effects. */
  run: <T>(
    id: string,
    work: (context: PluginServiceSessionWorkContextV1) => Promise<T>,
  ) => Promise<
    | { status: "completed"; value: T }
    | { status: "unavailable"; reason: string; retryAfterMs?: number }
  >;
};
