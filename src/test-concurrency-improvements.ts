import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  fileLocker,
  runInAgentWorkspace,
  executeWithFileTracking,
  smartQueue,
  executeWithSelectiveConcurrency,
} from "./enhanced-concurrency.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test function to demonstrate the improvements
async function testConcurrencyImprovements() {
  console.log("Testing concurrency improvements...\n");

  // 1. Test file locking system
  console.log("1. Testing file locking system...");

  const testFilePath = path.join(__dirname, "test-file-lock.txt");

  // Write to the file concurrently to test locking
  const writePromises = [];
  for (let i = 0; i < 5; i++) {
    writePromises.push(
      fileLocker.acquire(testFilePath, async () => {
        await fs.writeFile(testFilePath, `Content from operation ${i}\n`, { flag: "a" });
      }),
    );
  }

  await Promise.all(writePromises);
  console.log("✓ File locking test completed");

  // 2. Test workspace isolation
  console.log("\n2. Testing workspace isolation...");

  const workspacePath = await runInAgentWorkspace(
    "test-agent-1",
    async (workspacePath) => {
      const testFile = path.join(workspacePath, "isolated-test.txt");

      // Use fileLocker for safe file operations
      await fileLocker.acquire(testFile, async () => {
        await fs.writeFile(testFile, "Isolated content");
      });

      const content = await fileLocker.acquire(testFile, async () => {
        try {
          return await fs.readFile(testFile, "utf8");
        } catch {
          return null;
        }
      });

      console.log(`  Isolated file content: ${content?.substring(0, 15)}...`);
      return workspacePath;
    },
    {
      agentId: "test-agent-1",
      isolationEnabled: true,
      cleanupOnComplete: false,
    },
  );

  console.log(`  Workspace created at: ${workspacePath}`);
  console.log("✓ Workspace isolation test completed");

  // 3. Test selective concurrency
  console.log("\n3. Testing selective concurrency...");

  const operations = [
    {
      type: "read" as const,
      fn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "read result";
      },
      priority: 5 as const,
    },
    {
      type: "write" as const,
      fn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "write result";
      },
      priority: 1 as const, // high priority (lower number)
    },
    {
      type: "io" as const,
      fn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "io result";
      },
      priority: 5 as const,
    },
    {
      type: "compute" as const,
      fn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "compute result";
      },
      priority: 10 as const, // low priority (higher number)
    },
  ];

  const results = await Promise.all(
    operations.map((op) =>
      executeWithSelectiveConcurrency({
        type: op.type,
        fn: op.fn,
        priority: 5, // numeric priority
      }),
    ),
  );

  console.log(`  Results: ${results.join(", ")}`);
  console.log("✓ Selective concurrency test completed");

  // 4. Test smart queuing
  console.log("\n4. Testing smart queuing...");

  const queueResults = await Promise.all([
    executeWithFileTracking(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "file1 operation";
      },
      [path.join(__dirname, "file1.txt")],
      "high",
    ),

    executeWithFileTracking(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "file2 operation";
      },
      [path.join(__dirname, "file2.txt")],
      "normal",
    ),

    executeWithFileTracking(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "file1 operation again (conflicts with first)";
      },
      [path.join(__dirname, "file1.txt")],
      "normal",
    ),
  ]);

  console.log(`  Queue results: ${queueResults.join(", ")}`);
  console.log("✓ Smart queuing test completed");

  // Show queue statistics
  const stats = smartQueue.getStats();
  console.log(`\nQueue statistics: ${JSON.stringify(stats, null, 2)}`);

  // Cleanup
  await fs.unlink(testFilePath).catch(() => {}); // Ignore if file doesn't exist

  console.log("\n✓ All concurrency improvement tests passed!");
}

// Run the test if this file is executed directly
const isMain = process.argv[1] === __filename;

if (isMain) {
  testConcurrencyImprovements()
    .then(() => console.log("\nAll tests completed successfully!"))
    .catch((err) => console.error("Test failed:", err));
}

export { testConcurrencyImprovements };
