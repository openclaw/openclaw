import { randomBytes } from "node:crypto";
import type { SessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../config/sessions/session-actor-storage-contract.js";
import { restoreBoardError } from "./board-store-errors.js";
import type {
  BoardSessionTarget,
  BoardStore,
  BoardWriteOptions,
  BoardWidgetDocument,
  BoardSnapshotWithHtmlViewMetadata,
} from "./board-store.js";
import type { SessionActorBoardWrites } from "./session-actor-board-contract.js";

/** The routing owner supplies the already-acquired actor; this store never acquires a backend. */
export function createSessionActorBoardStore(
  resolve: (target: BoardSessionTarget) => SessionActorStorageBinding,
): BoardStore {
  const write = async <Key extends keyof SessionActorBoardWrites>(
    binding: SessionActorStorageBinding,
    type: Key,
    input: SessionActorBoardWrites[Key]["input"],
    options?: BoardWriteOptions,
  ): Promise<SessionActorBoardWrites[Key]["output"]> => {
    const authority: SessionActorStorageAuthority = {
      ...binding.authority,
      assertCurrent() {
        binding.authority.assertCurrent();
        options?.assertCurrent?.();
      },
    };
    const outcome = await binding.actor.storage!.mutate({ type, input }, authority);
    if (outcome.kind === "rolled-back") {
      throw restoreBoardError(Object.assign(new Error(outcome.error.message), outcome.error));
    }
    return outcome.value;
  };
  const readSnapshot = async <T>(
    target: BoardSessionTarget,
    consume: (value: BoardSnapshotWithHtmlViewMetadata) => T,
  ): Promise<Awaited<T>> => {
    const binding = resolve(target);
    const value = await binding.actor.storage!.read(
      {
        type: "boards.snapshot",
        input: { sessionKey: binding.actor.target.sessionKey },
      },
      binding.authority,
    );
    // A disclosure uses current membership; detached content may be an older committed snapshot.
    binding.actor.snapshot(binding.authority);
    return await consume(value);
  };
  const readDocument = async <T>(
    target: BoardSessionTarget,
    name: string,
    consume: (value: BoardWidgetDocument | undefined) => T,
    contentKind?: "mcp-app",
  ): Promise<Awaited<T>> => {
    const binding = resolve(target);
    const value = await binding.actor.storage!.read(
      {
        type: "boards.document",
        input: { sessionKey: binding.actor.target.sessionKey, name, contentKind },
      },
      binding.authority,
    );
    binding.actor.snapshot(binding.authority);
    return await consume(value);
  };
  const store: BoardStore = {
    useSnapshot(target, consume) {
      return readSnapshot(target, ({ snapshot }) => consume(snapshot));
    },
    useWidgetDocument(target, name, consume) {
      return readDocument(target, name, consume);
    },
    getSnapshot(target) {
      return readSnapshot(target, ({ snapshot }) => snapshot);
    },
    getSnapshotWithHtmlViewMetadata: (target) => readSnapshot(target, (value) => value),
    async applyOps(target, ops, options) {
      if (!ops.length) {
        return store.getSnapshot(target);
      }
      const binding = resolve(target);
      return write(
        binding,
        "boards.applyOps",
        {
          sessionKey: binding.actor.target.sessionKey,
          ops: structuredClone(ops),
        },
        options,
      );
    },
    async putWidget(input, options) {
      const binding = resolve(input);
      let params = structuredClone(input);
      const content = params.content;
      // Source permission preparation can reenter the actor and must stay outside its FIFO.
      if (
        content.kind === "mcp-app" &&
        content.interactive &&
        options?.resolveMcpAppInteraction &&
        !(await options.resolveMcpAppInteraction())
      ) {
        params = { ...params, content: { ...content, interactive: false }, declared: undefined };
      }
      return write(
        binding,
        "boards.putWidget",
        {
          sessionKey: binding.actor.target.sessionKey,
          params,
          viewGeneration: randomBytes(16).toString("hex"),
        },
        options,
      );
    },
    async grant(target, name, decision, revision, instanceId, options) {
      const binding = resolve(target);
      return write(
        binding,
        "boards.grant",
        {
          sessionKey: binding.actor.target.sessionKey,
          name,
          decision,
          revision,
          instanceId,
        },
        options,
      );
    },
    readWidgetMcpApp(target, name) {
      return readDocument(
        target,
        name,
        (value) => (value && "descriptor" in value ? value : undefined),
        "mcp-app",
      );
    },
  };
  return store;
}
