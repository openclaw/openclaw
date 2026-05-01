import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getFeatureLabStatus } from "./feature-lab-status.js";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feature-lab-test-"));
  tmpRoots.push(root);
  return root;
}

describe("feature lab status", () => {
  it("reads deployed SHA and service wiring", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "last-deployed-openclaw-sha.txt"), "abc123\n");
    const homeServiceDir = path.join(os.homedir(), ".config/systemd/user");
    fs.mkdirSync(homeServiceDir, { recursive: true });
    const servicePath = path.join(homeServiceDir, "openclaw-gateway.service");
    const original = fs.existsSync(servicePath) ? fs.readFileSync(servicePath, "utf8") : null;
    try {
      fs.writeFileSync(
        servicePath,
        "ExecStart=/usr/bin/node " +
          path.join(os.homedir(), "openclaw-feature-install/dist/index.js") +
          " gateway --port 18789\n",
      );
      const status = getFeatureLabStatus({ root });
      expect(status.deployedSha).toBe("abc123");
      expect(status.serviceUsesFeatureInstall).toBe(true);
      expect(status.serviceCommand).toContain("openclaw-feature-install/dist/index.js");
    } finally {
      if (original === null) {
        fs.rmSync(servicePath, { force: true });
      } else {
        fs.writeFileSync(servicePath, original);
      }
    }
  });
});
