import { createMemo, Errored, Loading, type Element } from "solid-js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { ChatModelControls } from "../chat/components/chat-model-controls.tsx";
import type { NewSessionModelControl, NewSessionModelRenderOptions } from "./model-control.ts";

function ModelCatalogStatus(props: {
  read: () => ModelCatalogResult | undefined;
  identity: object;
  children: () => Element;
}) {
  // Re-arm on admitted retries so the owner's loading status replaces a preceding error.
  const identity = createMemo(() => props.identity);
  const ready = createMemo(() => {
    props.read();
    return true;
  });
  return (
    <Errored fallback={() => props.children()}>
      <Loading on={identity()} fallback={props.children()}>
        {ready() ? props.children() : undefined}
      </Loading>
    </Errored>
  );
}

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
  const updates = createMemo(() =>
    projectSource(
      { control: control(), context: context() },
      {
        read: () => undefined,
        equality: "revision",
        subscribe: ({ control: modelOwner, context: app }, notify) => {
          // These owners mutate snapshots in place; identity alone cannot gate them.
          const owners = app ? [modelOwner, app.gateway, app.agents, app.config] : [modelOwner];
          const stops = owners.map((owner) => owner.subscribe(notify));
          return () => stops.forEach((stop) => stop());
        },
      },
    ),
  );
  const defaults = createMemo(() =>
    projectSource(context(), {
      // The draft reads defaults, never session rows. Capture field values so an
      // in-place default change still publishes; nested metadata is owner-replaced.
      read: (app) => Object.entries(app?.sessions.state.result?.defaults ?? {}),
      equality: (previous, next) =>
        previous.length === next.length &&
        previous.every(
          ([key, value], index) => key === next[index]?.[0] && value === next[index]?.[1],
        ),
      // Project only defaults changes; session-row publications must not rebuild controls.
      subscribe: (app, notify) => app?.sessions.subscribe(notify) ?? (() => {}),
    }),
  );
  // Keep receipt identity stable across unrelated owner publications.
  const read = createMemo(
    () => {
      updates().revision();
      return { promise: control().metadataRead, scope: control().metadataReadScope };
    },
    {
      equals: (previous, next) =>
        previous.promise === next.promise && previous.scope === next.scope,
    },
  );
  const metadata = createMemo(() => read().promise);
  const controls = createMemo(() => {
    updates().revision();
    defaults().revision();
    return control().renderProps({
      agent: agent(),
      agentId: agentId(),
      context: context(),
      sending: sending(),
    });
  });
  return (
    <ChatModelControls
      {...controls()}
      renderModelCatalogStatus={(render) => (
        <ModelCatalogStatus read={metadata} identity={read()}>
          {render}
        </ModelCatalogStatus>
      )}
    />
  );
}
