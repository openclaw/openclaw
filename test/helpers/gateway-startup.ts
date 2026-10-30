import { expect, vi } from "vitest";

/** Startup completion can precede recovery; raw clients need the public admission signal. */
export async function waitForGatewayStartup(port: number) {
  await vi.waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/startupz`);
      expect(await response.json()).toMatchObject({ ok: true, status: "started" });
    },
    { timeout: 10_000 },
  );
}
