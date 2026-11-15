import { channel } from "node:diagnostics_channel";
import { isInt32Array, isSharedArrayBuffer } from "node:util/types";
import {
  BroadcastChannel,
  getEnvironmentData,
  setEnvironmentData,
  threadId,
} from "node:worker_threads";

const declarationKey = "openclaw.test.postgresPoolRoots";
const rootChannel = "openclaw.postgres.pool.self-root";
const inherited: unknown = getEnvironmentData(declarationKey);
// jsdom supplies different constructors; native brands preserve the shared registry.
if (
  inherited !== undefined &&
  (!isInt32Array(inherited) || !isSharedArrayBuffer(inherited.buffer))
) {
  throw new Error("Invalid PostgreSQL test root declaration registry");
}
const declarations = inherited ?? new Int32Array(new SharedArrayBuffer(65_536 * 4));
setEnvironmentData(declarationKey, declarations);

// The config creates this shared registry before Vitest starts its native threads.
// Forks create their own registry, which their native fixture children inherit.
export function declarePostgresTestRoot(id = threadId): void {
  if (id === 0) {
    return;
  }
  for (let index = 0; index < declarations.length; index++) {
    const current = Atomics.load(declarations, index);
    if (
      current === id ||
      (current === 0 && Atomics.compareExchange(declarations, index, 0, id) === 0)
    ) {
      return;
    }
  }
  throw new Error("PostgreSQL test root declaration registry is full");
}

function assertDeclaredPostgresTestRoot(event: { threadId: number; owner: string }): void {
  if (
    event.threadId <= 0 ||
    !declarations.some((_, index) => Atomics.load(declarations, index) === event.threadId)
  ) {
    throw new Error(
      `Undeclared PostgreSQL pool self-root: ${event.owner} thread ${event.threadId}`,
    );
  }
}

const guardKey = Symbol.for("openclaw.test.postgresPoolRootGuard");

export function installPostgresTestRootGuard(): void {
  const shared = globalThis as typeof globalThis & {
    [guardKey]?: { broadcast: BroadcastChannel; diagnostic: ReturnType<typeof channel> };
  };
  if (shared[guardKey]) {
    return;
  }
  const broadcast = new BroadcastChannel(rootChannel);
  // Keep listening through worker retirement; late undeclared events still fail Vitest.
  broadcast.unref();
  broadcast.addEventListener("message", ({ data }) =>
    assertDeclaredPostgresTestRoot(data as { threadId: number; owner: string }),
  );
  const diagnostic = channel(rootChannel);
  diagnostic.subscribe((event) =>
    assertDeclaredPostgresTestRoot(event as { threadId: number; owner: string }),
  );
  // Bun's channel registry holds weak references, including subscribed channels.
  shared[guardKey] = { broadcast, diagnostic };
}
