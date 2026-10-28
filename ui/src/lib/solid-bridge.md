# Solid custom-element hosts

`defineSolidBridge(tag, content, spec)` registers a native custom element and
returns its Solid component. Keep this API and the existing host tag when
removing legacy renderers. Both entry points share the same Solid implementation.

The `content` callback renders the **inside** of the host, so callers never nest
or double-mount the registered tag:

```tsx
type Props = { open: boolean; label: string };
type Methods = { show(): void; close(): void };

export const Dialog = defineSolidBridge<Props, Methods>(
  "openclaw-example-dialog",
  (props, host) => (
    <dialog open={props.open} aria-label={props.label}>
      {props.children}
    </dialog>
  ),
  {
    properties: {
      open: { default: false, type: Boolean },
      label: { default: "" },
    },
    methods: {
      show: (host) => {
        host.open = true;
      },
      close: (host) => {
        host.open = false;
      },
    },
  },
);
```

This illustrates transport only; the modal primitive still owns native dialog,
focus, cancellation, animation, and occlusion policy.

Imperative callers create the registered tag or use `new Dialog.Element()` and
assign its properties. Solid callers use `<Dialog open={value}>…</Dialog>`, with
ordinary host attributes, events, and `ref` supported. Do not independently render
a raw registered tag from Solid: the returned component marks its host as
Solid-owned **before** any ref runs.

Each property declares a default. Attributes default to the lowercased property
name. Use `attribute: false` for objects/callbacks and an explicit name for dashed
attributes. `type` supports String, Number, and Boolean; otherwise it follows the
default value's primitive type. Reflection is opt-in. Declared methods receive
the typed host first, preserve arguments/return values, and work before connection.
Keep stateful behavior in the primitive's owner; methods can change declared
properties or invoke native DOM operations.

The optional `propertyChanged(host, key)` hook runs after a changed value is stored
and before rendering is scheduled. Equal assignments do not invoke it. Keep
cancellation and authority in that owner; the hook is not a second render lifecycle.

Host property reads and writes are synchronous. Each property has its own Solid
signal, so unchanged inputs do not invalidate other properties' computations.
Imperative callers await the host's `updateComplete` for committed synchronous
output. Each host retains its mount promise to preserve disconnect/reconnect
ordering. Solid-owned hosts publish into their parent's existing render cycle.
Completion does not wait for async resources, layout, or animations. Callers must
retain semantically unchanged object and callback references at their projection
owner; the bridge compares property values by identity.

Caller children move as one intact DOM range into `{props.children}`. Render it
exactly once, unconditionally, as the only children of a stable outlet. The caller
owns the whole outlet, including nodes and markers added by later updates. The
range is parked before root disposal and restored on reconnect. Existing `slot`
attributes remain intact; primitives own their named-content semantics. Do not
split, clone, or independently clear the caller's range.

The tooltip uses native shadow slots for default triggers and named rich content.
Its caller range remains directly under the host; Solid owns the shadow renderer.
The modal keeps its caller outlet separate from the transient overlay container
returned by `getOverlayContainer()`, so toasts never enter caller-owned content.

DOM moves within a turn retain the root. A genuine disconnect disposes it at the
microtask checkpoint. Reconnect creates a fresh root using current properties
and retained caller content. Moving to a different application provider also
replaces the root. The native DOM `context-request` protocol subscribes to
`ApplicationProvider` at its host boundary; the bridge never owns or disposes
application capabilities. Imperative pages publish layout traits to the existing
shell owner. Direct Solid callers inherit their application and shell providers.

Optional `connected(host)` and `disconnected(host)` hooks run synchronously for
both entry points, including same-turn moves. Native policies use them to release
focus custody, modal layers, and occlusion immediately; retaining the Solid root
does not retain presentation authority. Context-driven root replacement does not
call these DOM lifecycle hooks. A connection hook can run before content mounts,
so the policy also initializes from current host state when its renderer mounts.
