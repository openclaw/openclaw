import { getObserver } from "@solidjs/signals";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";

/** Track the owner without replacing its synchronous fields or message identities. */
export function projectChatRun<T extends object>(host: T): T {
  const source = chatRunPresentation(host);
  const projection = projectOwner(source, (owner) => owner.values);
  for (const key of source.fields) {
    const descriptor = Object.getOwnPropertyDescriptor(host, key)!;
    Object.defineProperty(host, key, {
      ...descriptor,
      get() {
        if (getObserver()) {
          projection.read();
        }
        return Reflect.get(source.values, key);
      },
    });
  }
  return host;
}
