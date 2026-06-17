commit cba738e1417ec8851c28532d4aae78eb0a378e7f
Author: Peter Steinberger <steipete@gmail.com>
Date:   Wed Jun 17 10:53:37 2026 +0100

    test(docker): isolate sandbox socket prerequisites

diff --git a/src/docker-setup.e2e.test.ts b/src/docker-setup.e2e.test.ts
index fc835550bc..965185644e 100644
--- a/src/docker-setup.e2e.test.ts
+++ b/src/docker-setup.e2e.test.ts
@@ -544,21 +544,25 @@ describe("scripts/docker/setup.sh", () => {
       "FROM scratch\n",
     );
     await resetDockerLog(activeSandbox);
+    const socketPath = join(activeSandbox.rootDir, "buildkit.sock");
 
-    const result = runDockerSetup(activeSandbox, {
-      OPENCLAW_SANDBOX: "1",
+    await withUnixSocket(socketPath, async () => {
+      const result = runDockerSetup(activeSandbox, {
+        OPENCLAW_SANDBOX: "1",
+        OPENCLAW_DOCKER_SOCKET: socketPath,
+      });
+
+      expect(result.status).toBe(0);
+      const buildLines = collectMatchingLines(await readDockerLogLines(activeSandbox), (line) =>
+        line.startsWith("build "),
+      );
+      expect(buildLines.length).toBeGreaterThanOrEqual(2);
+      const buildLinesWithoutBuildKit = collectMatchingLines(
+        buildLines,
+        (line) => !line.includes("DOCKER_BUILDKIT=1"),
+      );
+      expect(buildLinesWithoutBuildKit).toStrictEqual([]);
     });
-
-    expect(result.status).toBe(0);
-    const buildLines = collectMatchingLines(await readDockerLogLines(activeSandbox), (line) =>
-      line.startsWith("build "),
-    );
-    expect(buildLines.length).toBeGreaterThanOrEqual(2);
-    const buildLinesWithoutBuildKit = collectMatchingLines(
-      buildLines,
-      (line) => !line.includes("DOCKER_BUILDKIT=1"),
-    );
-    expect(buildLinesWithoutBuildKit).toStrictEqual([]);
   });
 
   it("offline mode reuses a preloaded local image without build or pull", async () => {
@@ -924,17 +928,21 @@ describe("scripts/docker/setup.sh", () => {
       join(activeSandbox.rootDir, "docker-compose.sandbox.yml"),
       "services:\n  openclaw-gateway:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
     );
+    const socketPath = join(activeSandbox.rootDir, "missing-cli.sock");
 
-    const result = runDockerSetup(activeSandbox, {
-      OPENCLAW_SANDBOX: "1",
-      DOCKER_STUB_FAIL_MATCH: "--entrypoint docker openclaw-gateway --version",
+    await withUnixSocket(socketPath, async () => {
+      const result = runDockerSetup(activeSandbox, {
+        OPENCLAW_SANDBOX: "1",
+        OPENCLAW_DOCKER_SOCKET: socketPath,
+        DOCKER_STUB_FAIL_MATCH: "--entrypoint docker openclaw-gateway --version",
+      });
+
+      expect(result.status).toBe(0);
+      expect(result.stderr).toContain("Sandbox requires Docker CLI");
+      const log = await readDockerLog(activeSandbox);
+      expect(log).toContain("config set agents.defaults.sandbox.mode off");
+      await expectMissingPath(join(activeSandbox.rootDir, "docker-compose.sandbox.yml"));
     });
-
-    expect(result.status).toBe(0);
-    expect(result.stderr).toContain("Sandbox requires Docker CLI");
-    const log = await readDockerLog(activeSandbox);
-    expect(log).toContain("config set agents.defaults.sandbox.mode off");
-    await expectMissingPath(join(activeSandbox.rootDir, "docker-compose.sandbox.yml"));
   });
 
   it("keeps offline policy when sandbox config writes fail and the gateway rolls back", async () => {
