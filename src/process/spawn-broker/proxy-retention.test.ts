import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker proxy lifetime", () => {
  it("releases completed command proxies after the host closes", async () => {
    const source = `
      import {createSpawnBrokerHost} from ${JSON.stringify(new URL("./host.js", import.meta.url).href)};
      const host = createSpawnBrokerHost();
      await host.ready();
      async function command() {
        const child = host.spawn('/bin/sh', ['-c', 'exit 0'], {stdio:'ignore'});
        await child.ready();
        await child.waitForClose();
        return new WeakRef(child);
      }
      const references = [];
      for (let index = 0; index < 5; index++) references.push(await command());
      await host.close();
      for (let index = 0; index < 5; index++) {
        await new Promise(setImmediate);
        globalThis.gc();
      }
      await new Promise(setImmediate);
      console.log(JSON.stringify({retained:references.filter(reference=>reference.deref()).length}));
    `;
    const fixture = spawn(
      process.execPath,
      ["--expose-gc", "--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const [stdout, stderr, [code]] = await Promise.all([
      text(fixture.stdout),
      text(fixture.stderr),
      once(fixture, "close"),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ retained: 0 });
  });
});
