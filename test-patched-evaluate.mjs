import { chromium } from "playwright-core";
import WebSocket from "ws";

const CDP_URL = "http://127.0.0.1:18800";

async function getTargetIdForPage(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const info = await session.send("Target.getTargetInfo");
    const targetId = String(info?.targetInfo?.targetId ?? "").trim();
    if (!targetId) {
      throw new Error("Missing targetId");
    }
    return targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function terminateExecutionViaCdp(cdpUrl, targetId) {
  const base = String(cdpUrl)
    .trim()
    .replace(/\/+$/, "")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/devtools\/browser\/.*$/, "")
    .replace(/\/cdp$/, "");
  const listUrl = `${base}/json/list`;
  const res = await fetch(listUrl, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch /json/list: HTTP ${res.status}`);
  }
  const pages = await res.json();
  const target = Array.isArray(pages) ? pages.find((p) => p?.id === targetId) : null;
  const wsUrl = String(target?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) {
    throw new Error("Missing webSocketDebuggerUrl for target");
  }

  const ws = new WebSocket(wsUrl, { handshakeTimeout: 2000 });
  await new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
    setTimeout(() => reject(new Error("WebSocket open timed out")), 2000);
  });

  ws.send(JSON.stringify({ id: 1, method: "Runtime.terminateExecution" }));
  await new Promise((r) => setTimeout(r, 250));
  ws.close();
}

async function raceTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function test() {
  console.log("Connecting to chromium...");
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10000 });
  const page = browser.contexts().flatMap((c) => c.pages())[0] ?? (await browser.newPage());
  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15000 });

  console.log("\n--- Test 1: Bounded async evaluate (Promise.race in browser) ---");
  try {
    await raceTimeout(
      page.evaluate(async () => {
        return Promise.race([
          (async () => {
            await new Promise((r) => setTimeout(r, 30_000));
            return "too slow";
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("evaluate timed out")), 3_000),
          ),
        ]);
      }),
      10_000,
      "evaluate",
    );
    console.log("❌ Expected bounded evaluate to timeout");
  } catch (e) {
    console.log("✅ Bounded evaluate timed out:", String(e).slice(0, 100));
  }

  console.log(
    "\n--- Test 2: Recover from a stuck CPU-bound evaluate using Runtime.terminateExecution ---",
  );
  const targetId = await getTargetIdForPage(page);
  const stuck = page.evaluate(() => {
    // Busy loop: Date.now() makes the condition non-constant for linters.
    // This should be interrupted by Runtime.terminateExecution.
    while (Date.now() < 10 ** 15) {
      // keep CPU busy
      void 0;
    }
    return "unreachable";
  });

  setTimeout(() => {
    void terminateExecutionViaCdp(CDP_URL, targetId).catch((err) => {
      console.error("terminateExecution failed:", String(err).slice(0, 200));
    });
  }, 1500);

  try {
    await raceTimeout(stuck, 8000, "stuck evaluate");
    console.log("❌ Expected stuck evaluate to be terminated");
  } catch (e) {
    console.log("✅ Stuck evaluate interrupted:", String(e).slice(0, 120));
  }

  console.log("\n--- Test 3: Page usable after termination ---");
  const title = await page.evaluate(() => document.title);
  console.log("✅ Title:", title);

  await browser.close();
  console.log("\nDone!");
}

test().catch((e) => {
  console.error("Fatal:", String(e));
  process.exit(1);
});
