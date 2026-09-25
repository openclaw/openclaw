import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

// Diagnostic capture only: do not synthesize messages, suppress animation, or write scroll state.
export async function traceCollaboratorVisuals(page: Page, dir: string, artifactName: string) {
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false });
  const geometry = process.env.OPENCLAW_TRACE_VISUAL_GEOMETRY !== "0";
  await page.addInitScript((captureGeometry) => {
    const frames: unknown[] = [];
    const events: unknown[] = [];
    const ids = new WeakMap<Node, number>();
    let nextId = 0;
    const id = (node: Node) => {
      let value = ids.get(node);
      if (!value) {
        value = ++nextId;
        ids.set(node, value);
      }
      return value;
    };
    const rect = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const mutation = new MutationObserver((records) => {
      const relevant = records.filter((record) =>
        (record.target instanceof Element ? record.target : record.target.parentElement)?.closest(
          ".chat-thread",
        ),
      );
      if (relevant.length) {
        events.push({
          t: performance.now(),
          kind: "mutation",
          count: relevant.length,
          changes: relevant.slice(0, 40).map((record) => ({
            target: id(record.target),
            type: record.type,
            attribute: record.attributeName,
            added: [...record.addedNodes].filter((node) => node instanceof Element).map(id),
            removed: [...record.removedNodes].filter((node) => node instanceof Element).map(id),
          })),
        });
      }
    });
    mutation.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    for (const name of [
      "animationstart",
      "animationend",
      "transitionstart",
      "transitionend",
      "wheel",
      "scroll",
    ]) {
      document.addEventListener(
        name,
        (event) => {
          const element = event.target;
          if (element instanceof Element && element.closest(".chat-thread")) {
            events.push({
              t: performance.now(),
              kind: name,
              node: id(element),
              classes: element.className,
            });
          }
        },
        { capture: true, passive: true },
      );
    }
    let alive = true;
    const tick = () => {
      const thread = document.querySelector<HTMLElement>(
        ".chat-pane-cache__pane--active .chat-thread",
      );
      if (thread) {
        const viewport = rect(thread);
        const rows = [...thread.querySelectorAll<HTMLElement>(".chat-virtual-row")].map((row) => ({
          node: id(row),
          key: row.dataset.virtualRowKey,
          index: row.dataset.index,
          rect: rect(row),
          offsetHeight: row.offsetHeight,
          intrinsic: row.style.containIntrinsicBlockSize,
          contentVisibility: getComputedStyle(row).contentVisibility,
        }));
        const texts = [...thread.querySelectorAll<HTMLElement>(".chat-text p")].flatMap(
          (element) => {
            const r = rect(element);
            if (r.y + r.h <= viewport.y || r.y >= viewport.y + viewport.h || !r.h) {
              return [];
            }
            const bubble = element.closest<HTMLElement>(".chat-bubble");
            const row = element.closest<HTMLElement>(".chat-virtual-row");
            const ancestors = [];
            for (
              let ancestor: HTMLElement | null = element;
              ancestor && ancestor !== thread;
              ancestor = ancestor.parentElement
            ) {
              const style = getComputedStyle(ancestor);
              if (
                style.opacity !== "1" ||
                style.transform !== "none" ||
                style.visibility !== "visible"
              ) {
                ancestors.push({
                  node: id(ancestor),
                  classes: ancestor.className,
                  opacity: style.opacity,
                  transform: style.transform,
                  visibility: style.visibility,
                });
              }
            }
            return [
              {
                node: id(element),
                text: element.textContent ?? "",
                rect: r,
                bubble: bubble ? id(bubble) : null,
                key: bubble?.dataset.messageId,
                row: row?.dataset.virtualRowKey,
                ancestors,
              },
            ];
          },
        );
        const overlaps = [];
        const duplicates = [];
        for (let i = 0; i < texts.length; i++) {
          for (let j = i + 1; j < texts.length; j++) {
            const a = texts[i]!;
            const b = texts[j]!;
            const dy =
              Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h) - Math.max(a.rect.y, b.rect.y);
            const dx =
              Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w) - Math.max(a.rect.x, b.rect.x);
            if (dy > 2 && dx > 2) {
              overlaps.push([a.node, b.node, dx, dy]);
            }
            if (a.text === b.text && a.text.length > 20) {
              duplicates.push([a.node, b.node]);
            }
          }
        }
        const block = thread.querySelector(".chat-virtual-block");
        const sizer = thread.querySelector(".chat-virtual-sizer");
        frames.push({
          t: performance.now(),
          top: thread.scrollTop,
          height: thread.scrollHeight,
          viewport,
          block: block ? rect(block) : null,
          sizer: sizer ? rect(sizer) : null,
          rows,
          texts,
          overlaps,
          duplicates,
        });
      }
      if (alive) {
        requestAnimationFrame(tick);
      }
    };
    if (captureGeometry) {
      requestAnimationFrame(tick);
    }
    Object.assign(window, {
      collaboratorVisualTrace: {
        frames,
        events,
        stop() {
          alive = false;
          mutation.disconnect();
        },
        mark(name: string) {
          performance.mark("collaborator:" + name);
          events.push({ t: performance.now(), kind: "mark", name });
        },
      },
    });
  }, geometry);
  return async () => {
    const evidence = await page.evaluate(() => {
      const trace = (
        window as Window & {
          collaboratorVisualTrace?: { frames: unknown[]; events: unknown[]; stop: () => void };
        }
      ).collaboratorVisualTrace;
      trace?.stop();
      return trace ? { frames: trace.frames, events: trace.events } : null;
    });
    await writeFile(path.join(dir, artifactName + "-visual-frames.json"), JSON.stringify(evidence));
    await page
      .context()
      .tracing.stop({ path: path.join(dir, artifactName + "-playwright-trace.zip") });
  };
}

export async function traceCollaboratorPaints(page: Page, dir: string) {
  const client = await page.context().newCDPSession(page);
  await client.send("Tracing.start", {
    categories:
      "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.screenshot",
    transferMode: "ReturnAsStream",
  });
  return async () => {
    const complete = new Promise<{ stream?: string }>((resolve) => {
      client.once("Tracing.tracingComplete", resolve);
    });
    await client.send("Tracing.end");
    const { stream } = await complete;
    if (!stream) {
      throw new Error("Browser paint trace did not return a stream");
    }
    const chunks: Buffer[] = [];
    while (true) {
      const chunk = await client.send("IO.read", { handle: stream });
      chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
      if (chunk.eof) {
        break;
      }
    }
    await client.send("IO.close", { handle: stream });
    await writeFile(path.join(dir, "browser-paints.json"), Buffer.concat(chunks));
    await client.detach();
  };
}

export async function markCollaboratorVisuals(page: Page, name: string) {
  await page.evaluate((label) => {
    (
      window as Window & { collaboratorVisualTrace?: { mark: (name: string) => void } }
    ).collaboratorVisualTrace?.mark(label);
  }, name);
}
