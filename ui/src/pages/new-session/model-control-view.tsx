import { createEffect, createMemo, untrack } from "solid-js";
import { projectSource } from "../../lib/reactive/projection.ts";
import { ChatModelControls } from "../chat/components/chat-model-controls.tsx";
import type { NewSessionModelControl, NewSessionModelRenderOptions } from "./model-control.ts";

export function NewSessionModelControlView(props: {
  control: NewSessionModelControl;
  options: NewSessionModelRenderOptions;
}) {
  // Draft revisions replace options, but text is not an input to model controls.
  const control = createMemo(() => props.control);
  const agent = createMemo(() => props.options.agent);
  const agentId = createMemo(() => props.options.agentId);
  const context = createMemo(() => props.options.context);
  const sending = createMemo(() => props.options.sending);
  const source = createMemo(() => ({ control: control(), context: context() }));
  const updates = projectSource(untrack(source), {
    read: () => undefined,
    equality: "revision",
    subscribe: ({ control: modelOwner, context: app }, notify) => {
      // These owners mutate snapshots in place; identity alone cannot gate them.
      const stops = [modelOwner.subscribe(notify)];
      if (app) {
        stops.push(
          app.gateway.subscribe(notify),
          app.agents.subscribe(notify),
          app.config.subscribe(notify),
        );
      }
      return () => stops.forEach((stop) => stop());
    },
  });
  createEffect(source, (next) => updates.replaceSource(next));
  const defaults = projectSource(untrack(context), {
    // The draft reads defaults, never session rows. Capture field values so an
    // in-place default change still publishes; nested metadata is owner-replaced.
    read: (app) => Object.entries(app?.sessions.state.result?.defaults ?? {}),
    equality: (previous, next) =>
      previous.length === next.length &&
      previous.every(
        ([key, value], index) => key === next[index]?.[0] && value === next[index]?.[1],
      ),
    subscribe: (app, notify) => app?.sessions.subscribe(notify) ?? (() => {}),
  });
  createEffect(context, (next) => defaults.replaceSource(next));
  const controls = createMemo(() => {
    updates.revision();
    defaults.revision();
    return control().renderProps({
      agent: agent(),
      agentId: agentId(),
      context: context(),
      sending: sending(),
    });
  });
  return <ChatModelControls {...controls()} />;
}
