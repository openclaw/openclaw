import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { createMemo, onCleanup } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { availableLinkReaders } from "../app/link-reader-routing.ts";
import { resolveLinkReaderTarget } from "../components/link-reader-target.ts";
import type { MarkdownTextReferences } from "../components/markdown-render-options.ts";
import {
  prepareMarkdownTextReferenceSnapshot,
  prepareMarkdownTextReferences,
} from "../components/markdown-text-references.ts";
import { projectSource } from "../lib/reactive/projection.ts";

export type Binding = {
  context?: Pick<ApplicationContext, "gateway" | "plugins">;
  session: BoardGetParams;
  presented: boolean;
};

function admitted(binding: Binding) {
  const { context } = binding;
  if (!context || !binding.presented) {
    return [];
  }
  const readers = availableLinkReaders(context.gateway.snapshot);
  return context.plugins.registrations("textReferences").flatMap((entry) => {
    const reader = readers.find(
      (candidate) =>
        candidate.pluginId === entry.value.reader.pluginId &&
        candidate.id === entry.value.reader.id,
    );
    return reader && !entry.signal.aborted ? [{ entry, reader }] : [];
  });
}

/** The visible transcript owns observations; registrations and reader metadata own admission. */
export function createTextReferenceProjection(read: () => Binding) {
  const currentBinding = createMemo(read, {
    equals: (a, b) =>
      a.context === b.context &&
      a.session.sessionKey === b.session.sessionKey &&
      a.session.agentId === b.session.agentId &&
      a.presented === b.presented,
  });
  const source = createMemo(() => {
    const lifetime = new AbortController();
    onCleanup(() => lifetime.abort());
    return projectSource(currentBinding(), {
      read(binding): MarkdownTextReferences {
        return prepareMarkdownTextReferences(
          admitted(binding).flatMap(({ entry, reader }) => {
            try {
              const snapshot = entry.value.snapshot(binding.session);
              return [
                prepareMarkdownTextReferenceSnapshot({
                  key: `${entry.key}\0${JSON.stringify(reader.linkReader)}\0${snapshot.key}`,
                  resolve(input) {
                    if (
                      lifetime.signal.aborted ||
                      entry.signal.aborted ||
                      !admitted(binding).some(
                        (current) =>
                          current.entry.signal === entry.signal && current.reader === reader,
                      )
                    ) {
                      return [];
                    }
                    try {
                      return snapshot
                        .resolve(input)
                        .filter((value) => resolveLinkReaderTarget(value.url, [reader]));
                    } catch (error) {
                      binding.context?.plugins.reportError(entry.pluginId, error);
                      return [];
                    }
                  },
                }),
              ];
            } catch (error) {
              binding.context?.plugins.reportError(entry.pluginId, error);
              return [];
            }
          }),
        );
      },
      subscribe(binding, notify) {
        if (!binding.context || !binding.presented) {
          return () => {};
        }
        type Observation = { reader: object; abort: AbortController; stop?: () => void };
        const observations = new Map<AbortSignal, Observation>();
        const retire = (signal: AbortSignal) => {
          const previous = observations.get(signal);
          observations.delete(signal);
          previous?.abort.abort();
          previous?.stop?.();
        };
        let initialized = false;
        const sync = () => {
          let changed = false;
          const current = admitted(binding);
          for (const [signal, observation] of observations) {
            if (
              !current.some(
                ({ entry, reader }) => entry.signal === signal && reader === observation.reader,
              )
            ) {
              retire(signal);
              changed = true;
            }
          }
          for (const { entry, reader } of current) {
            if (observations.has(entry.signal)) {
              continue;
            }
            changed = true;
            const abort = new AbortController();
            const observation: Observation = { reader, abort };
            observations.set(entry.signal, observation);
            try {
              const cleanup = entry.value.observe?.(
                { ...binding.session, signal: AbortSignal.any([abort.signal, entry.signal]) },
                () => {
                  if (!abort.signal.aborted && !entry.signal.aborted) {
                    notify();
                  }
                },
              );
              // Plugin code may synchronously withdraw its registration before returning cleanup.
              if (abort.signal.aborted || observations.get(entry.signal) !== observation) {
                cleanup?.();
              } else {
                observation.stop = cleanup;
              }
            } catch (error) {
              binding.context?.plugins.reportError(entry.pluginId, error);
              retire(entry.signal);
            }
          }
          if (!initialized || changed) {
            initialized = true;
            notify();
          }
        };
        const stops = [
          binding.context?.plugins.subscribe(sync),
          binding.context?.gateway.subscribe(sync),
        ];
        sync();
        return () => {
          stops.forEach((stop) => stop?.());
          for (const signal of observations.keys()) {
            retire(signal);
          }
        };
      },
      equality: (a, b) => a.key === b.key,
    });
  });
  return createMemo(() => source().read());
}
