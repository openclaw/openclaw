# Control UI projections

These adapters expose existing owners to Solid 2 through `@solidjs/signals`.
They do not own Gateway state, request admission, persistence, or mutations.
Import the specific adapter module needed by a view; there is no eager barrel
that loads all registries or page owners.

## State and lifetime

`projectSource(source, contract)` performs an initial read. `read()` reads through
to the synchronous owner; Solid notifications become visible at its normal flush
boundary. A tracked `read()` or `revision()` acquires the upstream subscription.
Explicit `subscribe()` consumers share that subscription. It is released when
the last reactive observer and explicit subscriber leave, and reacquired with a
fresh read when observation resumes.

Every adapter declares its equality contract. `"revision"` publishes every
owner notification, including mutations of the same object. Value comparators
are reserved for immutable values. Do not put mutable snapshots behind
`Object.is` or copy them into a second writable store.

Pass a new scope object to `replaceSource()` when a connection, agent, session,
or query changes. Replacement releases the previous subscription before
acquiring the new one; stale deliveries cannot update the projection. Do not
mutate scope objects in place. Creating an adapter under a Solid owner binds its
disposal to that owner. All adapters also expose idempotent `dispose()` for
explicit application, pane, or test lifetimes. Disposal releases observation and
retains the last read/published reference; it does not deep-freeze owner objects
or dispose the authoritative owner.

Event consumers subscribe directly to their owners, preserving each channel's
delivery order, replay behavior, and completion contract.

## Adapter families

| Module                   | Owners                                            |
| ------------------------ | ------------------------------------------------- |
| `application.ts`         | Gateway snapshots, config, agent selection        |
| `application-native.ts`  | Native device settings                            |
| `domain-capabilities.ts` | Agents, roster activity, channels, runtime config |
| `events-browser.ts`      | Lobster visits                                    |

`projectTheme()` exposes preference and applied-palette projections separately.
Preferences change immediately; `appliedPalette` advances only after the theme
owner applies the accepted stylesheet generation. A failed stylesheet still
follows the owner's existing readable-default behavior. The projection never
loads or applies CSS itself.

Solid consumers import `t` from `lib/reactive/i18n.ts` and keep the call shape
`t("key", params)`. It reads a locale/catalog revision through `projectI18n()`.
The existing Lit translator and English registrars are unchanged. Locale loading,
fallback, persistence, and stale-load rejection stay in the i18n manager. Solid
consumers call `registerEnglishCatalog(registerPageEnglish)` before reading that
page's lazy keys. This delegates to the existing owner and notifies the Solid
projections; repeated English registration does not trigger render loops.
Calling a legacy registrar directly does not notify Solid readers.

`ApplicationContext` and its supporting types live in `app/context-types.ts`.
`app/context.ts` retains the Lit token during migration. Solid callers use
`ApplicationProvider` and `useApplication()` from `context.ts` in this directory;
both renderers receive the same capability object. Providers do not assume
ownership of those capabilities.

These foundations do not mount new product UI. The tests exercise real owner
publication paths plus shared subscription, replacement, and disposal contracts.

## Retained Solid panes

`createParkedProjection(read, presented)` keeps the last presentation while a
mounted pane is hidden. It stops reading its source and drops those reactive
dependencies until reveal, then reads the current owner once. A first hidden
mount reads once without subscribing so the retained DOM can be initialized.
Return immutable presentation values from `read`: parking does not clone or
freeze mutable domain objects. Project their displayed fields rather than
holding a mutable object and reading its fields directly from JSX.

Chat's `createSolidRenderLifecycle` in `pages/chat/solid-render-lifecycle.ts`
uses this projection for its `snapshot` accessor. Create it in the pane's Solid
owner, pass the pane's `presented` accessor (including document visibility when
the pane owns that policy), and render from `snapshot()`. `read` may consume
existing owner projections; imperative owners call `invalidate()` after their
synchronous mutations. The existing frame-coalescing owner still controls
stream invalidation cadence.

`afterCommit` requests a new generation and runs in Solid's split-effect apply
phase, after DOM bindings. Requests made from a callback wait for the following
generation. `afterLayout` additionally waits for a browser animation frame;
ResizeObserver, child custom elements, images, and overlay animations retain
their own settlement contracts. Both methods own returned cleanup until the
callback calls `complete`, is cancelled, the pane parks, or the owner disposes.
Pending callbacks wait through parking; disposal cancels them. Lit callers keep
using the renderer-neutral interface and the existing controller adapter until
their port lands.
