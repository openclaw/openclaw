# Interim Solid custom elements

`defineSolidBridge(tag, content, spec)` is the only Lit-to-Solid tag adapter during
the migration. Delete it after the last Lit caller is ported. Remove the old Lit
class and registration in the same change that introduces its replacement.

The returned Solid component renders the existing host tag. Its `content`
callback renders the **inside** of that host, so both entry points share one
implementation and never nest or double-mount the tag:

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

Lit callers keep `<openclaw-example-dialog .open=${value}>…</…>`. Solid callers
use `<Dialog open={value}>…</Dialog>`, with ordinary host attributes, events, and
`ref` supported. Do not independently render a raw registered tag from Solid:
the returned component marks its host as Solid-owned **before** any ref runs.

Each property declares a default. Attributes default to the lowercased property
name, matching Lit. Use `attribute: false` for objects/callbacks and an explicit
name for dashed attributes. `type` supports String, Number, and Boolean;
otherwise it follows the default value's primitive type. Reflection is opt-in.
Declared methods receive the typed host first, preserve arguments/return values,
and work before connection. Keep stateful behavior in the primitive's owner;
methods can change declared properties or invoke its native DOM operations.

For owners that must invalidate requests or presentation synchronously, the optional
`propertyChanged(host, key)` hook runs after a changed value is stored and before
rendering is scheduled. Equal assignments do not invoke it. Keep cancellation and
authority in that owner; the hook is not a second render lifecycle.

Host property reads and writes are synchronous. Each property has its own Solid
signal; unchanged inputs do not invalidate other properties' computations.
Lit-owned bridges publish their final property values together and share one
microtask flush, so awaiting the caller's `updateComplete` sees committed
synchronous Solid output. Solid-owned hosts publish into their parent's existing
render cycle. The bridge also exposes `updateComplete` for imperative callers.
Neither completion promise waits for async resources, layout, or animations.
Callers must retain semantically unchanged object and callback references at
their projection owner; the bridge compares property values by identity.

Caller children move as one intact DOM range into `{props.children}`. Render it
exactly once, unconditionally, as the only children of a stable outlet. Lit's
final child part can append to the outlet without an end marker, so the entire
outlet belongs to the caller. Lit retains ownership of the
nodes and markers inside that range, including nodes added by later updates.
The range is parked before root disposal and restored on reconnect. Existing
`slot` attributes remain intact; primitives own their named-content semantics.
Do not split, clone, or independently clear this range: that breaks the caller's
Lit parts. Template-valued properties remain opaque values; never hand them to
Solid as JSX.

DOM moves within a turn retain the root. A genuine disconnect disposes it at the
microtask checkpoint. Reconnect creates a fresh root using current properties
and the retained caller content. Moving to a different application provider
also replaces the root. The bridge uses the DOM `context-request` protocol to
subscribe to the existing application's Lit provider; it never owns or disposes
the application capabilities. Lit-hosted pages also publish layout traits to the
existing shell layout owner. Direct Solid callers inherit their application and
shell layout providers.

The Lit ratchet excepts only this bridge test's Lit imports and templates, which
prove caller compatibility. Other metrics and paths stay gated. Delete that
path-exact exception with the bridge at cutover.
