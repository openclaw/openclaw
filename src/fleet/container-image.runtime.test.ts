import { describe, expect, it, vi } from "vitest";
import { prepareFleetGatewayImage } from "./container-image.runtime.js";

const imageId = `sha256:${"a".repeat(64)}`;
const result = (stdout: string, code = 0) => ({ stdout, stderr: "", code });

describe("Fleet image capability preflight", () => {
  it.each(["docker", "podman"] as const)(
    "probes immutable %s image without state or secrets",
    async (runtime) => {
      const execute = vi.fn(async (_runtime: string, args: string[]) =>
        result(args[0] === "image" ? imageId : "  --published-port <port>  Mapped port\n"),
      );
      await expect(
        prepareFleetGatewayImage(execute, runtime, "example/openclaw:latest"),
      ).resolves.toBe(imageId);
      const probe = execute.mock.calls[1]?.[1] ?? [];
      expect(probe).toContain(imageId);
      expect(probe).not.toContain("example/openclaw:latest");
      expect(probe).toEqual(
        expect.arrayContaining([
          "--rm",
          "--pull=never",
          "--network",
          "none",
          "--entrypoint",
          "node",
        ]),
      );
      for (const flag of ["-e", "-v", "--env-file", "--mount", "--volume"]) {
        expect(probe.slice(0, probe.indexOf(imageId))).not.toContain(flag);
      }
    },
  );

  it.each([
    "Usage: gateway\n",
    "  --published-port-other <port>\n",
    "Description mentions --published-port but has no option\n",
  ])("refuses unsupported help %j", async (help) => {
    const execute = vi.fn(async (_runtime: string, args: string[]) =>
      result(args[0] === "image" ? imageId : help),
    );
    await expect(prepareFleetGatewayImage(execute, "docker", "old:image")).rejects.toThrow(
      "does not support gateway --published-port",
    );
  });
});
