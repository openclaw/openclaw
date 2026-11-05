/** Visible sidebar presentation, excluding transient action hover and reconnect status. */
export function sidebarPresentationProbe() {
  type Row = {
    key: string;
    glyphs: string[];
    avatars: string[];
    images: string[];
    ownerAvatars: number;
    presenceAvatars: number;
    unread: number;
    badges: string[];
  };
  type Box = { x: number; y: number; width: number; height: number };
  const box = (element: Element): Box => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  type Frame = {
    at: number;
    cached: boolean;
    scrollTop: number;
    sidebar: Box;
    rowLabel: { key: string; box: Box } | null;
    reconnectMasks: Array<Box & { name: string; reason: string }>;
    chrome: Array<{
      name: string;
      opacity: string;
      disabled: boolean;
      animations: Array<{ name: string; startTime: number | null }>;
      images: Array<{
        src: string;
        currentSrc: string;
        complete: boolean;
        width: number;
        height: number;
      }>;
    }>;
    rows: Row[];
    mountedRows: Array<Pick<Row, "key" | "avatars" | "images">>;
    links: { href: string | null; class: string }[];
    mountedKeys: (string | null)[];
    issues: { present: boolean; count: string | null };
  };
  const artwork = (icon: Element) => {
    if (icon.localName === "svg") {
      return icon.innerHTML;
    }
    const mask = icon.getAttribute("style")?.match(/data:image\/svg\+xml,([^"\s]+)"/u)?.[1];
    if (!mask) {
      return "missing CSS artwork";
    }
    const template = document.createElement("template");
    template.innerHTML = decodeURIComponent(mask);
    return template.content.firstElementChild?.innerHTML ?? "invalid CSS artwork";
  };
  const frames: Frame[] = [];
  let stopped = false;
  let dirty = true;
  let signature: string | undefined;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (
        target?.closest("aside.sidebar") &&
        !target.closest(".session-action, .tooltip-surface, .sidebar-session-hovercard")
      ) {
        dirty = true;
        break;
      }
    }
  });
  const imageChanged = (event: Event) => {
    if (event.target instanceof HTMLImageElement && event.target.closest("aside.sidebar"))
      dirty = true;
  };
  document.addEventListener("load", imageChanged, true);
  document.addEventListener("error", imageChanged, true);
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const sample = () => {
    if (stopped) {
      return;
    }
    const sidebar = document.querySelector("aside.sidebar");
    if (sidebar && dirty) {
      dirty = false;
      const viewport = sidebar.querySelector(".sidebar-shell__body")?.getBoundingClientRect();
      const rows = [
        ...sidebar.querySelectorAll(".sidebar-session-content .sidebar-recent-session"),
      ].filter((row) => {
        const rect = row.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          (!viewport || (rect.bottom > viewport.top && rect.top < viewport.bottom))
        );
      });
      const sidebarBox = box(sidebar);
      const rowLabel = (() => {
        for (const row of rows) {
          const clip = row.querySelector(".sidebar-recent-session__name");
          const text = clip?.querySelector(".hover-marquee__text");
          const node = [...(text?.childNodes ?? [])].find(
            (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
          );
          if (!clip || !node) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          const limit = clip.getBoundingClientRect();
          const x = Math.max(rect.left, limit.left, viewport?.left ?? 0, sidebarBox.x);
          const right = Math.min(
            rect.right,
            limit.right,
            viewport?.right ?? Infinity,
            sidebarBox.x + sidebarBox.width,
          );
          const top = Math.max(rect.top, limit.top, viewport?.top ?? 0, sidebarBox.y);
          const bottom = Math.min(
            rect.bottom,
            limit.bottom,
            viewport?.bottom ?? Infinity,
            sidebarBox.y + sidebarBox.height,
          );
          if (
            right > x &&
            bottom > top &&
            rect.top >= (viewport?.top ?? sidebarBox.y) &&
            rect.bottom <= (viewport?.bottom ?? sidebarBox.y + sidebarBox.height)
          ) {
            return {
              key: row.getAttribute("data-session-key") ?? "",
              box: { x, y: top, width: right - x, height: bottom - top },
            };
          }
        }
        return null;
      })();
      const presentation = {
        sidebar: sidebarBox,
        rowLabel,
        reconnectMasks: [
          ...sidebar.querySelectorAll(".sidebar-identity-card__status, .sidebar-connection-flag"),
        ]
          .filter(
            (element) =>
              element.checkVisibility({ checkOpacity: true }) &&
              element.getBoundingClientRect().width > 0 &&
              element.getBoundingClientRect().height > 0,
          )
          .map((element, index) => ({
            ...box(element),
            name: `reconnect-${index}`,
            reason: "Permitted reconnect indicator",
          })),
        chrome: [
          ["brand", ".sidebar-agent-card__avatar"],
          ["ownerPicker", ".sidebar-session-owner-filter .picker-select__trigger"],
          ["home", ".sidebar-footer-bar__home"],
          ["inbox", ".sidebar-issues-button"],
          ["footer", ".sidebar-identity-card__avatar"],
        ].flatMap(([name, selector]) => {
          const element = sidebar.querySelector(selector!);
          return element
            ? [
                {
                  name: name!,
                  opacity: getComputedStyle(element).opacity,
                  disabled: element.matches(":disabled"),
                  animations:
                    name === "home"
                      ? element
                          .getAnimations({ subtree: true })
                          .filter(
                            (animation): animation is CSSAnimation =>
                              animation instanceof CSSAnimation,
                          )
                          .map((animation) => ({
                            name: animation.animationName,
                            startTime:
                              typeof animation.startTime === "number" ? animation.startTime : null,
                          }))
                      : [],
                  images: [...element.querySelectorAll("img")].map((image) => ({
                    src: image.src,
                    currentSrc: image.currentSrc,
                    complete: image.complete,
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                  })),
                },
              ]
            : [];
        }),
        scrollTop: sidebar.querySelector(".sidebar-shell__body")?.scrollTop ?? 0,
        links: [...sidebar.querySelectorAll("a[href]")].map((link) => ({
          href: link.getAttribute("href"),
          class: link.className,
        })),
        mountedKeys: [...sidebar.querySelectorAll("[data-session-key]")].map((row) =>
          row.getAttribute("data-session-key"),
        ),
        mountedRows: [...sidebar.querySelectorAll(".sidebar-recent-session")].map((row) => ({
          key: row.getAttribute("data-session-key") ?? "",
          avatars: [...row.querySelectorAll('[class*="avatar"]')].map((avatar) => avatar.className),
          images: [...row.querySelectorAll("img")].map((image) => image.getAttribute("src") ?? ""),
        })),
        rows: rows.map((row) => ({
          key: row.getAttribute("data-session-key") ?? "",
          avatars: [...row.querySelectorAll('[class*="avatar"]')].map((avatar) => avatar.className),
          images: [...row.querySelectorAll("img")].map((image) => image.getAttribute("src") ?? ""),
          ownerAvatars: row.querySelectorAll('.sidebar-session-indicator [class*="avatar"]').length,
          presenceAvatars: row.querySelectorAll(
            '.sidebar-recent-session__details-endcap [class*="avatar"]',
          ).length,
          glyphs: [
            ...[...row.querySelectorAll(".session-glyph")].flatMap((glyph) => {
              const content = [
                ...glyph.querySelectorAll(
                  ".session-glyph__content svg,.session-glyph__content .session-css-icon",
                ),
              ]
                .filter((svg) => !svg.closest(".viewer-avatar, .identity-avatar"))
                .map(artwork);
              const running = glyph.classList.contains("session-glyph--running");
              const badge = glyph.querySelectorAll(".session-glyph__badge--unread").length;
              // Avatar shape is separate; its run/unread decoration still belongs in the gate.
              return content.length || running || badge
                ? [
                    JSON.stringify({
                      content,
                      running,
                      badge,
                      queued: Boolean(
                        glyph.querySelector(
                          ".session-glyph__ring--queued,.session-glyph__trace--queued",
                        ),
                      ),
                    }),
                  ]
                : [];
            }),
            ...[
              ...row.querySelectorAll(
                ".sidebar-session-team-state__status svg,.sidebar-child-session__status svg,.sidebar-session-team-state__status .session-css-icon,.sidebar-child-session__status .session-css-icon",
              ),
            ]
              .filter((svg) => !svg.closest(".session-glyph"))
              .map(artwork),
          ],
          unread: row.querySelectorAll(
            ".session-glyph__badge--unread,.session-unread-dot,.sidebar-agent-roster__unread",
          ).length,
          badges: [...row.querySelectorAll(".session-row-badge")].map((badge) =>
            JSON.stringify({
              classes: badge.className,
              state: badge.getAttribute("data-pull-request-state"),
              count: badge.textContent?.trim(),
            }),
          ),
        })),
        issues: {
          present: Boolean(sidebar.querySelector(".sidebar-issues-button")),
          count:
            sidebar.querySelector(".sidebar-issues-button__count")?.textContent?.trim() ?? null,
        },
      };
      const next = JSON.stringify(presentation);
      const cached = sidebar.getAttribute("data-snapshot-state") === "cached";
      if (next !== signature || frames.at(-1)?.cached !== cached) {
        signature = next;
        frames.push({ at: performance.now(), cached, ...presentation });
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  Reflect.set(window, "__sidebarPresentation", {
    read() {
      stopped = true;
      observer.disconnect();
      document.removeEventListener("load", imageChanged, true);
      document.removeEventListener("error", imageChanged, true);
      const first = frames.findIndex((frame) => frame.cached && frame.rows.length > 0);
      const visible = first < 0 ? [] : frames.slice(first);
      const handoff = visible.findIndex((frame) => !frame.cached);
      const before = visible[handoff - 1];
      const after = visible[handoff];
      const handoffChanges =
        before?.rows.length && after?.rows.length ? { glyphs: 0, badges: 0, issues: 0 } : null;
      if (before && after && handoffChanges) {
        handoffChanges.issues = Number(
          JSON.stringify(before.issues) !== JSON.stringify(after.issues),
        );
        for (const row of before.rows) {
          const live = after.rows.find((item) => item.key === row.key);
          if (live) {
            handoffChanges.glyphs += Number(
              JSON.stringify(row.glyphs) !== JSON.stringify(live.glyphs),
            );
            handoffChanges.badges += Number(
              row.unread !== live.unread ||
                JSON.stringify(row.badges) !== JSON.stringify(live.badges),
            );
          }
        }
      }
      const initial = frames.find((frame) => frame.cached);
      const final = frames.at(-1);
      const initialKeys = new Set(initial?.mountedKeys);
      const finalKeys = new Set(final?.mountedKeys);
      const parity =
        initial && final && !final.cached
          ? {
              initialRows: initial.mountedKeys.length,
              finalRows: final.mountedKeys.length,
              added: [...finalKeys].filter((key) => !initialKeys.has(key)).length,
              removed: [...initialKeys].filter((key) => !finalKeys.has(key)).length,
              avatars: initial.mountedRows.filter((row) => {
                const live = final.mountedRows.find((value) => value.key === row.key);
                return (
                  !live ||
                  JSON.stringify([row.avatars, row.images]) !==
                    JSON.stringify([live.avatars, live.images])
                );
              }).length,
            }
          : null;
      const sidebar = (
        frames.find((frame) => frame.cached && frame.rows.length > 0) ?? frames.at(-1)
      )?.sidebar;
      const reconnectMasks = [
        ...new Map(
          frames
            .flatMap((frame) => frame.reconnectMasks)
            .map((mask) => [JSON.stringify(mask), mask]),
        ).values(),
      ];
      return {
        timeOrigin: performance.timeOrigin,
        sidebar,
        reconnectMasks,
        frames,
        waves: Math.max(0, visible.length - 2),
        handoffChanges,
        parity,
      };
    },
  });
}
