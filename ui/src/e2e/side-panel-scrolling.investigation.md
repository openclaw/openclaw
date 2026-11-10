# Side-panel scrolling investigation

**Draft investigation only. No verified fix. Do not merge or deploy this packet.**

Operation: `side-panel-scrolling-20261110`.

This packet supports evidence collection for an iPad Pro Safari report: the
Mergebeat dashboard cannot always be scrolled to its bottom as a side panel,
while expanding the panel works. It changes no production code, configuration,
permissions, or tests. It is not proof that current main reproduces the defect.

## Source and ownership

- Repository: https://github.com/openclaw/openclaw
- Pinned investigation base: `8569bd9edfadb9d08539083cae19b3680ef49b3c`.
- Original rendered-DOM capture identified build `058ef8863a286837164fba01be4b2334d01d452f`.
  That capture postdates the original recording; neither pins today's live server.
- The implementation/PR owner retains the original draft branch. Evidence
  collectors may clone/fork the published head and push sanitized evidence to
  their own copy, then return its URL and full commit SHA. Do not update the
  owning branch, create a competing fix, merge, or deploy.
- Record the actual live build separately from the local checkout's commit.
  The published draft's exact head must be recorded with every local result.

## Established observations and open hypotheses

| Evidence                                                                                                             | What it establishes                                       | What it does not establish                                                   |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Reporter uses an up-to-date iPad Pro with Safari                                                                     | Reported affected device/browser                          | Exact iPadOS/Safari version or current-main reproduction                     |
| Recording reaches part of the lower dashboard, then shows earlier sections                                           | Visible movement in side-panel mode                       | Gesture direction, automatic snap-back, or root cause; touches are not shown |
| Rendered DOM has one full-width, full-bleed page widget, allocated 20 grid rows                                      | The captured layout and widget mode                       | Its computed viewport, inner document size, or a defect in the row cap       |
| Source fits a single-page dashboard to its viewport in expanded/main mode, but retains a scrolling grid in side mode | Different outer scroll ownership in the two presentations | A proven Safari scroll-handoff defect                                        |

The recording shows a landscape, side-by-side layout. The later rendered DOM
shows a narrower mobile dock. Exercise these as separate reachable states; do
not combine them into an impossible fixture.

The 20-row allocation corresponds to 1348 CSS pixels using the existing 56-pixel
rows and 12-pixel gaps. A long embedded document can therefore have its own
scrollable content while the surrounding board scrolls. This is a hypothesis
selection aid, not justification to remove the cap or add a manual touch relay.

Related historical repair: https://github.com/openclaw/openclaw/pull/171468
removed a touch-motion relay for inline visualizations. Its Chromium proof did
not establish physical Safari behavior, and it is not a confirmed fix for this
side-panel case.

## Reproduction and evidence collection

Use an existing authorized dashboard view. Do not change sharing, credentials,
permissions, browser security, the live Gateway, or the dashboard's saved content.
Opening, scrolling, expanding, and restoring the panel are the only intended
live interactions.

1. Record browser/OS version, viewport, touch versus mouse/trackpad input, page
   zoom, and the actual live build. On Windows, explicitly label results
   **Chromium/Windows, not native iOS Safari**.
2. Open Mergebeat's `mergebeat-pulse` widget beside chat in landscape. For the
   narrow-layout scenario, use the mobile dock separately.
3. Scroll over the embedded dashboard toward its last section. Note whether the
   bottom is reachable and whether movement reverses after input stops. Do not
   infer automatic reversal if the input direction is unknown.
4. At a stuck position, run the top-page probe below in the top document's
   inspector console. Save the returned object as `side-stuck`.
5. Select the inner widget document with the inspector's normal execution-context
   selector, then run the inner-frame probe. Save as `side-inner`. If the browser
   does not expose that context, report it; do not bypass cross-origin isolation.
6. Expand through the visible panel control, scroll to the bottom, and capture
   equivalent `expanded-bottom` and `expanded-inner` readings.
7. Restore split and try again. Also compare a gesture over the widget with one
   starting in the outer board's gutter. Keep each input method separate.
8. Return readings and a concise expected/actual description. If Chromium passes,
   report that result without claiming the Safari defect is absent or fixed.

Sanitize screenshots and recordings before publication: crop out unrelated
browser tabs, bookmarks, sidebar entries, chat, profile information, and URLs.
Do not upload complete DOM dumps, widget source containing private data, HARs,
cookies, local storage, view tickets, or authentication-bearing URLs. For each
capture, report the mode and input action in text. Keep raw private evidence
outside the repository; attach sanitized media through an authorized upload path.

## Specific questions to answer

- Is the outer board at its bottom while the inner document still has remaining
  scroll distance? Does input over the iframe advance that inner document?
- Does the iframe viewport or any clipping ancestor extend below the allocated
  visible panel? Compare computed geometry, not only the inline grid span.
- Does expanding merely change available height, or change the scroll owner that
  receives input? Does restoring split reproduce the failure?
- Is a nested dashboard control consuming the gesture? Capture its scroll offset
  separately rather than equating it with the document's offset.

## Reusing the existing test boundary

For local proof, use an isolated checkout at the published head, with its own
frozen dependencies. Reuse `dashboard-fullscreen.e2e.test.ts` for sandbox scroll
remainder and expanded/split retention, `chat-widget-scroll.e2e.test.ts` for trusted
touch input, and `../test-helpers/control-ui-e2e.ts` for the mock Gateway.

Synthetic content should be a tall, full-width, full-bleed HTML widget with auto
height, one widget on the active tab, and a final-row marker. Retain the real
nested sandbox frames. Exercise landscape tablet side layout and narrow dock,
then expanded and restored split. A helper-only scroll assignment can establish
geometry, not native gesture handling. Chromium mobile emulation and desktop
WebKit results must be labeled separately from physical iPad Safari.

## Validation status at draft creation

- Passed: JavaScript syntax checks for the two probe snippets and whitespace
  inspection of this investigation-only packet.
- Not run: probes in a browser, product regression, native iOS Safari, candidate
  fix tests, build, and independent implementation review. There is no fix yet.
- Local browser launch was blocked by missing `libglib-2.0.so.0`. The supported
  dependency installer required unavailable system privileges.
- The configured remote-test provider was blocked by a missing Blacksmith CLI;
  no remote lease or test ran. These are environment gaps, not product failures.

## Read-only top-page probe

Run in the top page. This returns layout and scroll offsets, not document text,
URLs, storage, or credentials. It does not change scrolling or attach listeners.

```javascript
// Read-only geometry probe. Run in the top-page console on the affected Safari tab.
// Returns no content text, URLs, cookies, storage, profile IDs, or credentials.
(() => {
  const panel = [...document.querySelectorAll('[data-panel-slot="dashboard"]')].find(
    (node) => node.getClientRects().length && !node.closest("[hidden], [inert]"),
  );
  if (!panel) return { error: "No visible dashboard panel in this document" };
  const board = panel.querySelector("openclaw-board-view");
  const widget = panel.querySelector('[data-test-id="board-widget"]');
  const frame = widget?.querySelector("iframe");
  const measure = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      tag: node.tagName.toLowerCase(),
      className: node.className,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      remaining: node.scrollHeight - node.clientHeight - node.scrollTop,
      overflowY: style.overflowY,
      display: style.display,
      gridTemplateRows: style.gridTemplateRows,
      touchAction: style.touchAction,
      overscrollBehaviorY: style.overscrollBehaviorY,
    };
  };
  const ancestors = [];
  for (let node = frame; node && node !== document.body; node = node.parentElement) {
    ancestors.push(measure(node));
  }
  return {
    viewport: { width: innerWidth, height: innerHeight, visualHeight: visualViewport?.height },
    layout: panel.closest(".sidebar-region")?.className,
    mobileMode: panel.closest(".chat-mobile-host")?.getAttribute("data-mode") ?? null,
    board: measure(board),
    widget: measure(widget),
    frame: measure(frame),
    ancestors,
  };
})();
```

## Read-only inner-frame probe

Select the **inner widget document**, not the top page or the outer sandbox host.
The probe reports the document and up to 20 nested scrollable elements among the
first 1000 body descendants. It is bounded diagnostic evidence, not an exhaustive
inventory or a browser security workaround.

```javascript
// Read-only. Run with Web Inspector's execution context set to the inner
// Mergebeat widget document, not the top page or the outer sandbox host.
(() => {
  const measure = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      tag: node.tagName.toLowerCase(),
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      remaining: node.scrollHeight - node.clientHeight - node.scrollTop,
      overflowY: style.overflowY,
      touchAction: style.touchAction,
      overscrollBehaviorY: style.overscrollBehaviorY,
    };
  };
  const nested = [];
  let inspected = 0;
  for (const node of document.querySelectorAll("body *")) {
    if (++inspected > 1000 || nested.length >= 20) break;
    if (
      node.clientHeight > 0 &&
      node.scrollHeight > node.clientHeight + 1 &&
      ["auto", "scroll"].includes(getComputedStyle(node).overflowY)
    ) {
      nested.push(measure(node));
    }
  }
  return {
    viewport: { width: innerWidth, height: innerHeight },
    root: measure(document.scrollingElement),
    body: measure(document.body),
    nested,
  };
})();
```
