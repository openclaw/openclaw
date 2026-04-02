import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasAnyWhatsAppAuth } from "./whatsapp-auth-presence.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("hasAnyWhatsAppAuth", () => {
  it("resolves account authDir against the provided environment", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-auth-"));
    tempDirs.push(homeDir);
    const authDir = path.join(homeDir, "wa-auth");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, "creds.json"), "{}\n", "utf8");

    expect(
      hasAnyWhatsAppAuth(
        {
          channels: {
            whatsapp: {
              accounts: {
                custom: {
                  authDir: "~/wa-auth",
                },
              },
            },
          },
        },
        { HOME: homeDir } as NodeJS.ProcessEnv,
      ),
    ).toBe(true);
  });
});
