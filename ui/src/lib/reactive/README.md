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

`projectEvents()` preserves synchronous event delivery, duplicates, order, and
the upstream subscription lifetime. It has no latest-value signal or replay.
`projectAsyncEvents()` aggregates returned promises for channels that await
observers, so publisher completion still includes the consumers' work. Channels whose own
contract replays an admitted value, such as native drafts, retain that behavior.

## Adapter families

| Module                   | Owners                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application.ts`         | Gateway snapshots/events/logs, config, selections, navigation preferences, dock/input, creation metadata, overlays, mentions, attention, scope upgrade, push, placement startup |
| `application-native.ts`  | Native drafts, conversation presentation, device settings, notifications, Gateway inventory                                                                                     |
| `domain-capabilities.ts` | Agents, identity, roster activity, channels, runtime config, sessions and managed list queries                                                                                  |
| `domain-keyed.ts`        | Projects, progress cards, pull requests, stored outbox reads                                                                                                                    |
| `domain-board.ts`        | Board value/event sources, existing providers, shared scoped provider leases                                                                                                    |
| `registries.ts`          | Model catalog, chat metadata, MCP contexts, chat work, plugin help, palette preferences                                                                                         |
| `events.ts`              | Boot retirement, HTTP failure/auth restoration, outbox/draft/attention changes, snapshot invalidation, initial handoff, activation clearing, picker confirmations               |
| `events-browser.ts`      | Browser history, native browser state, native occlusion, lobster visits, transcript scroll events                                                                               |
| `router.ts`              | Router state, with loaders and route retirement left in the router                                                                                                              |

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
page's lazy keys, and use `registerLocaleCatalog(manager, locale, catalog)` for
catalog replacement. These delegate to the existing owners and notify only the
Solid projections; repeated English registration does not trigger render loops.
Calling a legacy registrar directly does not notify Solid readers.

`ApplicationContext` and its supporting types live in `app/context-types.ts`.
`app/context.ts` retains the Lit token during migration. Solid callers use
`ApplicationProvider` and `useApplication()` from `context.ts` in this directory;
both renderers receive the same capability object. Providers do not assume
ownership of those capabilities.

These foundations do not mount new product UI. The tests exercise real owner
publication paths plus shared subscription, replacement, and disposal contracts.
