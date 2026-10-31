import { listen } from "../../lib/reactive/listener.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type {
  CreationComposer,
  CreationComposerContext,
  CreationComposerTransfer,
} from "./creation-composer.ts";

// Accepted input stays app-scoped, but only the lazy creation/chat surfaces load its owner.
const acceptedComposers = new WeakMap<
  CreationComposerContext,
  { entries: Map<string, CreationComposer>; release: () => void }
>();

export function retainCreatedComposer(
  context: CreationComposerContext,
  key: string,
  composer: CreationComposer,
): void {
  let registry = acceptedComposers.get(context);
  if (!registry) {
    const entries = new Map<string, CreationComposer>();
    const dispose = () => {
      for (const value of entries.values()) {
        value.dispose();
      }
      entries.clear();
      registry?.release();
    };
    // Scope changes release accepted input custody even while its view is unmounted.
    const unsubscribe = context.gateway.subscribe(() => {
      for (const [entryKey, value] of entries) {
        if (!value.canRecover()) {
          value.dispose();
          entries.delete(entryKey);
        }
      }
      if (!entries.size) {
        registry?.release();
      }
    });
    const stopLifetime = context.lifecycleAbortSignal
      ? listen(context.lifecycleAbortSignal, "abort", dispose, { once: true })
      : undefined;
    registry = {
      entries,
      release: () => {
        unsubscribe();
        stopLifetime?.();
        if (acceptedComposers.get(context) === registry) {
          acceptedComposers.delete(context);
        }
      },
    };
    acceptedComposers.set(context, registry);
  }
  const previous = registry.entries.get(key);
  if (previous && previous !== composer) {
    previous.dispose();
  }
  registry.entries.set(key, composer);
}

export function takeCreatedComposer(
  context: CreationComposerContext,
  sessionKey: string,
  client: object | null,
): CreationComposerTransfer | undefined {
  const registry = acceptedComposers.get(context);
  const key =
    registry &&
    [...registry.entries.keys()].find((candidate) =>
      areUiSessionKeysEquivalent(candidate, sessionKey),
    );
  const composer = key ? registry?.entries.get(key) : undefined;
  if (
    !registry ||
    !key ||
    !composer ||
    client !== context.gateway.snapshot.client ||
    !composer.canRecover()
  ) {
    return undefined;
  }
  return composer.take(() => {
    if (registry.entries.get(key) === composer) {
      registry.entries.delete(key);
    }
    if (!registry.entries.size) {
      registry.release();
    }
  });
}
