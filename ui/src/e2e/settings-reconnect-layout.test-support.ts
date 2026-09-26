import assert from "node:assert/strict";
import path from "node:path";
import type { Page } from "playwright";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";

const reconnectLogLines = Array.from({ length: 180 }, (_, index) =>
  JSON.stringify({
    "0": JSON.stringify({ subsystem: "reconnect-layout" }),
    "1": `Synthetic entry ${index + 1}`,
    time: new Date(Date.UTC(2026, 8, 19, 10, 0, index)).toISOString(),
    _meta: { logLevelName: "info" },
  }),
);

async function readReconnectLayout(page: Page, selector = ".log-stream") {
  return page.locator(selector).evaluate((stream) => {
    const main = stream.closest<HTMLElement>("main")!;
    const notice = main.querySelector<HTMLElement>(".connection-action-block");
    const header = main.querySelector<HTMLElement>(".content-header")!;
    const outlet = main.querySelector<HTMLElement>("openclaw-router-outlet")!;
    const rect = stream.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const noticeRect = notice?.getBoundingClientRect();
    return {
      height: stream.clientHeight,
      scrollHeight: stream.scrollHeight,
      top: stream.scrollTop,
      gap: stream.scrollHeight - stream.scrollTop - stream.clientHeight,
      bottom: rect.bottom,
      contentBottom: mainRect.bottom - Number.parseFloat(getComputedStyle(main).paddingBottom),
      noticeHeight: noticeRect?.height ?? 0,
      noticeTop: noticeRect?.top ?? null,
      mainTop: mainRect.top,
      mainPaddingTop: Number.parseFloat(getComputedStyle(main).paddingTop),
      headerGap: noticeRect ? header.getBoundingClientRect().top - noticeRect.bottom : null,
      titlePadding: Number.parseFloat(
        getComputedStyle(main).getPropertyValue("--settings-content-block-start-padding"),
      ),
      blocked: outlet.inert && outlet.getAttribute("aria-disabled") === "true",
    };
  });
}

async function settleReconnectLayout(page: Page) {
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
}

export async function exerciseLogsReconnect(
  page: Page,
  baseUrl: string,
  options: { reader: boolean; bounded: boolean; artifactDir?: string },
) {
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "logs.tail": {
        sequence: [
          { cursor: 180, file: "synthetic.log", lines: reconnectLogLines, reset: true },
          { cursor: 180, file: "synthetic.log", lines: [], reset: false },
        ],
      },
    },
  });
  await page.goto(`${baseUrl}logs`);
  await page.locator(".log-row").nth(179).waitFor();
  const stream = page.locator(".log-stream");
  await page.waitForFunction(() => {
    const element = document.querySelector(".log-stream")!;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  const originalStream = await stream.elementHandle();
  assert(originalStream);
  if (options.reader) {
    await stream.evaluate((element) => {
      element.scrollTop = 2700;
    });
    await settleReconnectLayout(page);
  }
  const before = await readReconnectLayout(page);
  assert(before.scrollHeight > before.height * 2);
  assert(before.top > 0);
  if (options.reader) {
    assert(before.gap > 120);
  }
  const capture = async (name: string) => {
    if (options.artifactDir) {
      await page.screenshot({ path: path.join(options.artifactDir, `${name}.png`) });
    }
  };
  await capture("connected");
  const connects = (await gateway.getRequests("connect")).length;
  await gateway.deferNext("connect");
  await gateway.closeLatest(1012, "synthetic layout reconnect");
  await page.locator(".connection-action-block").waitFor();
  await settleReconnectLayout(page);
  const offline = await readReconnectLayout(page);
  await capture("disconnected");
  console.log("reconnect-layout", JSON.stringify({ before, offline }));
  assert(
    await originalStream.evaluate((element) => element === document.querySelector(".log-stream")),
  );
  assert.equal(await page.locator(".log-row").count(), 180);
  assert(offline.blocked);
  assert(offline.noticeHeight >= 44);
  assert(Math.abs(offline.noticeTop! - offline.mainTop - offline.mainPaddingTop) <= 1);
  assert(Math.abs(offline.headerGap! - offline.titlePadding) <= 1);
  if (options.bounded) {
    assert(offline.bottom <= offline.contentBottom + 1, "stream must fit below the notice");
    assert(
      Math.abs(before.bottom - offline.bottom) <= 1 && offline.height < before.height,
      "the notice must take height from the stream, not extend the page",
    );
  } else {
    assert.equal(offline.height, before.height);
  }
  assert(Math.abs(offline.top - before.top) <= 1, "disconnect must preserve nonzero scrollTop");

  const tails = (await gateway.getRequests("logs.tail")).length;
  await gateway.deferNext("logs.tail");
  await gateway.waitForRequest("connect", { after: connects });
  await gateway.resolveDeferred("connect");
  await gateway.waitForRequest("logs.tail", { after: tails });
  await page.locator(".connection-action-block").waitFor({ state: "detached" });
  await gateway.resolveDeferred("logs.tail", {
    cursor: 181,
    file: "synthetic.log",
    lines: [...reconnectLogLines, reconnectLogLines[0]!.replace("entry 1", "entry 181")],
    reset: true,
  });
  await page.locator(".log-row").nth(180).waitFor();
  await settleReconnectLayout(page);
  const recovered = await readReconnectLayout(page);
  await capture("reconnected");
  assert(!recovered.blocked);
  assert.equal(recovered.height, before.height);
  assert(
    await originalStream.evaluate((element) => element === document.querySelector(".log-stream")),
  );
  if (options.reader) {
    assert(
      Math.abs(recovered.top - before.top) <= 1,
      "reconnect reset must not turn a reader into a follower",
    );
    assert(recovered.gap > 120);
  } else {
    await page.waitForFunction(() => {
      const element = document.querySelector(".log-stream")!;
      return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
    });
  }
  return { before, offline, recovered };
}
