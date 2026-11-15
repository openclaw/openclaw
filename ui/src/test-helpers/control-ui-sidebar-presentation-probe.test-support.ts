/** Sidebar row presentation and saved scroll across cached/live adoption. */
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
  type Frame = {
    at: number;
    cached: boolean;
    scrollTop: number;
    rows: Row[];
    mountedRows: Array<Pick<Row, "key" | "avatars" | "images">>;
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
  const pendingFrames: Array<() => void> = [];
  const channel = new MessageChannel();
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
  const scrolled = (event: Event) => {
    if (event.target instanceof Element && event.target.closest("aside.sidebar")) {
      dirty = true;
    }
  };
  document.addEventListener("scroll", scrolled, true);
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
      const presentation = {
        scrollTop: sidebar.querySelector(".sidebar-shell__body")?.scrollTop ?? 0,
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
  };
  channel.port1.addEventListener("message", () => {
    sample();
    for (const resolve of pendingFrames.splice(0)) {
      resolve();
    }
  });
  channel.port1.start();
  const requestSample = () => {
    if (!stopped) {
      // rAF precedes ResizeObserver; this task samples after the rendering update.
      channel.port2.postMessage(null);
      requestAnimationFrame(requestSample);
    }
  };
  requestAnimationFrame(requestSample);
  const probe = {
    nextFrame: () =>
      new Promise<void>((resolve) => {
        pendingFrames.push(resolve);
      }),
    read() {
      stopped = true;
      channel.port1.close();
      channel.port2.close();
      observer.disconnect();
      document.removeEventListener("scroll", scrolled, true);
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
      return {
        sampling: "after-render-task",
        timeOrigin: performance.timeOrigin,
        frames,
        waves: Math.max(0, visible.length - 2),
        handoffChanges,
      };
    },
  };
  Reflect.set(window, "__sidebarPresentation", probe);
  return probe;
}
