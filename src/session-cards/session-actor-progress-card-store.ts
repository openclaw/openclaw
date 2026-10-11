import type { SessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import type { ProgressCardStore } from "../gateway/progress-card-store.js";

/** Stores private progress cards in the session actor selected by the routing owner. */
export function createSessionActorProgressCardStore(
  resolve: (sessionKey: string, agentId?: string) => SessionActorStorageBinding,
): ProgressCardStore {
  return {
    async get(sessionKey, agentId) {
      const binding = resolve(sessionKey, agentId);
      const card = await binding.actor.storage!.read(
        {
          type: "progressCard.get",
          input: { sessionKey: binding.actor.target.sessionKey },
        },
        binding.authority,
      );
      return card;
    },
    async put(sessionKey, input, agentId) {
      const binding = resolve(sessionKey, agentId);
      const result = await binding.actor.storage!.mutate(
        {
          type: "progressCard.put",
          input: {
            sessionKey: binding.actor.target.sessionKey,
            ...structuredClone({
              markdown: input.markdown,
              steps: input.steps,
              expectedRevision: input.expectedRevision,
            }),
          },
        },
        {
          ...binding.authority,
          assertCurrent() {
            binding.authority.assertCurrent();
            input.assertCurrent?.();
          },
        },
      );
      if (result.kind === "rolled-back") {
        throw Object.assign(new Error(result.error.message), { name: result.error.name });
      }
      return "card" in result.value ? result.value : { card: null };
    },
  };
}
