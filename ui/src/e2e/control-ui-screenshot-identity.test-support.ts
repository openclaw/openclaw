import photon from "@silvia-odwyer/photon-node";
import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";

export function defineControlUiFrameIdentityTests(createPage: () => Promise<Page>) {
  it("reprepares a proof target replaced while its final intersection is pending", async () => {
    const page = await createPage();
    await page.setContent(
      '<style>#proof { width: 100px; height: 40px; background: rgb(160, 48, 176); }</style><div id="proof">Ready</div>',
    );
    await page.evaluate(() => {
      const NativeObserver = window.IntersectionObserver;
      let inspections = 0;
      let replaced = false;
      // Count native readiness samples, not layout-only observations.
      window.IntersectionObserver = class extends NativeObserver {
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          super((entries, observer) => {
            const forwarded = entries.map((entry) => {
              let consumed = false;
              return new Proxy(entry, {
                get(target, key) {
                  if (key === "intersectionRect" && !consumed && target.target.id === "proof") {
                    consumed = true;
                    inspections += 1;
                  }
                  return Reflect.get(target, key, target);
                },
              });
            });
            callback(forwarded, observer);
          }, options);
        }
        override observe(element: Element) {
          super.observe(element);
          // Replace after two agreeing samples but before the next native delivery.
          if (element.id === "proof" && inspections === 2 && !replaced) {
            replaced = true;
            element.outerHTML = '<div id="proof" data-replaced="true">Replacement</div>';
          }
        }
      };
    });
    const proof = page.locator("#proof");
    const frame = await takeControlUiScreenshotFrame(page, proof, [proof], {
      elements: [proof],
      animations: "disabled",
    });
    expect(await proof.getAttribute("data-replaced")).toBe("true");
    expect(await proof.textContent()).toBe("Replacement");
    expect(frame.elements[0]!.bounds).toEqual({ x: 8, y: 8, width: 100, height: 40 });
    const crop = photon.PhotonImage.new_from_byteslice(frame.elements[0]!.png);
    try {
      const center =
        (Math.floor(crop.get_height() / 2) * crop.get_width() + Math.floor(crop.get_width() / 2)) *
        4;
      expect([...crop.get_raw_pixels().subarray(center, center + 3)]).toEqual([160, 48, 176]);
    } finally {
      crop.free();
    }
  });

  it("captures proof targets inside an iframe in viewport coordinates", async () => {
    const page = await createPage();
    await page.setContent(
      '<iframe style="position:absolute;left:40px;top:60px;border:0" srcdoc="<style>body { margin:0 } #proof { width:100px;height:40px;background:purple }</style><div id=proof>Ready</div>"></iframe>',
    );
    const surface = page.locator("iframe");
    const proof = surface.contentFrame().locator("#proof");
    const frame = await takeControlUiScreenshotFrame(page, surface, [proof], {
      elements: [proof],
      animations: "disabled",
    });
    expect(frame.elements[0]!.bounds).toEqual({ x: 40, y: 60, width: 100, height: 40 });
  });

  it.each(["hidden", "clipped", "removed", "moved", "replaced"] as const)(
    "rejects a proof target %s during native frame capture",
    async (change) => {
      const page = await createPage();
      await page.setContent(
        '<style>#clip { width: 200px; height: 80px; overflow: hidden; } #proof { width: 100px; height: 40px; background: purple; }</style><div id="clip"><div id="proof">Ready</div></div>',
      );
      const context = page.context();
      const newSession = context.newCDPSession.bind(context);
      const capture = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
        const session = await newSession(target);
        const send = session.send.bind(session);
        vi.spyOn(session, "send").mockImplementation(async (method, params) => {
          if (method === "Page.captureScreenshot") {
            // Mutate at the actual capture boundary, then forward the native CDP
            // capture. No fabricated pixels or helper readiness results.
            await page.locator("#proof").evaluate((element, mutation) => {
              const mutations = {
                hidden: () => element.setAttribute("style", "visibility: hidden"),
                clipped: () => {
                  element.parentElement!.style.height = "0px";
                },
                removed: () => element.remove(),
                moved: () => element.setAttribute("style", "transform: translateX(10px)"),
                replaced: () => element.replaceWith(element.cloneNode(true)),
              };
              mutations[mutation]();
            }, change);
          }
          return send(method, params);
        });
        return session;
      });
      try {
        const proof = page.locator("#proof");
        await expect(
          takeControlUiScreenshotFrame(page, page.locator("body"), [proof], {
            animations: "disabled",
          }),
        ).rejects.toThrow("Proof content moved or disappeared during frame capture");
      } finally {
        capture.mockRestore();
      }
    },
  );
}
