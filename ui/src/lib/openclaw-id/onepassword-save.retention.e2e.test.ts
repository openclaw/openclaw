// @vitest-environment node
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("leaves no kit payload in Chromium's heap despite retained vendor listeners", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./onepassword-save.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "kitAdapter",
    platform: "browser",
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    // Random synthetic strings are supplied as values, not embedded in retained script source.
    const marker = `synthetic-kit-${crypto.randomUUID()}`;
    await page.evaluate((payloadMarker) => {
      // The bundle publishes a test-only global, with its real public adapter signature.
      const adapter = Reflect.get(window, "kitAdapter");
      for (let index = 0; index < 4; index++) {
        const host = document.createElement("div");
        document.body.append(host);
        const dispose = adapter.mountOnePasswordKit(
          host,
          {
            title: payloadMarker,
            username: payloadMarker,
            code: payloadMarker,
            notes: payloadMarker,
            url: "https://demo.example.test",
          },
          () => {},
        );
        dispose();
        host.remove();
      }
    }, marker);
    const protocol = await page.context().newCDPSession(page);
    await protocol.send("HeapProfiler.collectGarbage");
    const chunks: string[] = [];
    protocol.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => chunks.push(chunk));
    await protocol.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    const snapshot = JSON.parse(chunks.join(""));
    // This covers closure contexts as well as DOM; checking only values is insufficient.
    expect(snapshot.strings.some((value: string) => value.includes(marker))).toBe(false);
    // Native DOM attribute storage is outside V8's string table. Enumerate even
    // detached elements and inspect their attributes/properties through CDP too.
    const prototype = await protocol.send("Runtime.evaluate", { expression: "Element.prototype" });
    const elements = await protocol.send("Runtime.queryObjects", {
      prototypeObjectId: prototype.result.objectId!,
    });
    const attributes = await protocol.send("Runtime.callFunctionOn", {
      objectId: elements.objects.objectId!,
      functionDeclaration: `function() {
        return this.filter(element => element instanceof Element && element.constructor.prototype !== element).flatMap(element => [
          ...Array.from(element.attributes, attribute => attribute.value),
          element instanceof HTMLButtonElement ? element.value : "",
        ]);
      }`,
      returnByValue: true,
    });
    expect(attributes.exceptionDetails).toBeUndefined();
    const encoded = Buffer.from(
      JSON.stringify({
        title: marker,
        fields: [
          { autocomplete: "username", value: marker },
          { autocomplete: "new-password", value: marker },
        ],
        notes: marker,
        urls: ["https://demo.example.test"],
      }),
    ).toString("base64");
    expect(
      attributes.result.value.some(
        (value: string) => value.includes(marker) || value.includes(encoded),
      ),
    ).toBe(false);
    await protocol.send("Runtime.releaseObject", { objectId: elements.objects.objectId! });
    await protocol.send("Runtime.releaseObject", { objectId: prototype.result.objectId! });
  } finally {
    await browser.close();
  }
});
