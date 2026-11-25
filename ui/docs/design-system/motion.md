# Motion

OpenClaw uses a three-step duration scale with purpose-matched easing functions. Every animation should serve a functional goal — transitions that exist only for aesthetics add cognitive load without benefit.

---

## Duration Scale

Defined in `ui/src/styles/base.css`:

| Token               | Value   | Use                                                       |
| ------------------- | ------- | --------------------------------------------------------- |
| `--duration-fast`   | `100ms` | Micro-interactions: hover color, focus ring, icon swap    |
| `--duration-normal` | `180ms` | Standard transitions: menu open, tab switch, input expand |
| `--duration-slow`   | `300ms` | Page-level: sheet slide-in, modal fade, skeleton reveal   |

Non-token durations in use (document when adding new ones):

| Context                | Value                          | File              |
| ---------------------- | ------------------------------ | ----------------- |
| Shimmer tokens         | see below                      | `base.css`        |
| Composer border/shadow | `var(--duration-fast)` = 100ms | `chat/layout.css` |

---

## Easing Functions

Defined in `ui/src/styles/base.css`:

| Token           | Curve                           | Use                                                     |
| --------------- | ------------------------------- | ------------------------------------------------------- |
| `--ease-out`    | `cubic-bezier(0.16, 1, 0.3, 1)` | Most enter/expand transitions — fast start, smooth land |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)`  | Elements that travel across screen (slides, drawers)    |

**Default rule of thumb:** Use `--ease-out` unless the element explicitly moves from point A to point B (use `--ease-in-out`).

---

## `prefers-reduced-motion` Pattern

Every animation or transition **must** be suppressed when the user has requested reduced motion. Use the global reset already present in `base.css` for light DOM. Shadow roots need a local guard because the global reset cannot reach them. Otherwise, add per-component overrides only to preserve a non-animated state change (e.g. instant opacity change is acceptable, instant position snap is acceptable).

```css
/* Already in base.css — covers animations and transitions in light DOM */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Opt-in decorative motion that should vanish entirely belongs inside `@media (prefers-reduced-motion: no-preference)`.

---

## Shimmer

`base.css` owns the only two shimmers. Do not add keyframes, gradients, or per-surface durations for either.

| Family      | Use                                                | Keyframe       | Tokens                                                                                                                                          |
| ----------- | -------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Placeholder | `.skeleton`, for content that has not loaded       | `shimmer`      | `--skeleton-duration` 2s, `--skeleton-easing` ease-in-out, `--skeleton-highlight-strength` 12%, `--skeleton-sweep-width` 50%                    |
| Label       | `.text-shimmer`, on real text while work is active | `text-shimmer` | `--text-shimmer-duration` 2.4s, `--text-shimmer-easing` ease-in-out, `--text-shimmer-highlight-strength` 100%, `--text-shimmer-sweep-width` 30% |

Surfaces may set `--skeleton-base` to fit their background. Everything else is shared.

| Mode                     | `.skeleton`                              | `.text-shimmer`           |
| ------------------------ | ---------------------------------------- | ------------------------- |
| `prefers-reduced-motion` | Static block, highlight parked offscreen | The element's static text |
| `forced-colors`          | Static block, highlight parked offscreen | The element's static text |

Both animate compositor or paint properties only: `transform` for `.skeleton::after`, `background-position` for `.text-shimmer`. Apply `.text-shimmer` conditionally from the state that means work is active.

---

## Animation Inventory

| Name                   | File              | Duration                            | Purpose                                                                                          |
| ---------------------- | ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `shimmer`              | `base.css`        | `--skeleton-duration`, infinite     | `.skeleton::after` transform; compositor-only, locked by `ui/src/styles/shimmer.browser.test.ts` |
| `text-shimmer`         | `base.css`        | `--text-shimmer-duration`, infinite | `.text-shimmer` background-position sweep on a text-clipped gradient                             |
| Composer border/shadow | `chat/layout.css` | 100ms (`--duration-fast`)           | Focus ring on input area                                                                         |
| Workboard card glass   | `workboard.css`   | —                                   | Static (no animation)                                                                            |
| Dreams diary reveal    | `dreams.css`      | 1.4s, cubic-bezier                  | Entry reveal keyframe with blur-to-clear effect                                                  |

---

## Anti-Patterns

- ❌ Adding new keyframe animations without a `prefers-reduced-motion` suppression
- ❌ Using `animation-iteration-count: infinite` outside of active loading or listening indicators
- ❌ Duration > 500ms for UI chrome elements (feels sluggish)
- ❌ `linear` easing for enter/exit — always use a curve from the token set
- ❌ CSS transitions on `transform` and `opacity` simultaneously with `filter` — causes GPU layer explosion on mobile
