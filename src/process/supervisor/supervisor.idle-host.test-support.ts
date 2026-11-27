import assert from "node:assert/strict";
import { createProcessSupervisor } from "./supervisor.js";

const [environment, command] = process.argv.slice(2);
assert.ok(environment === "inherited" || environment === "replacement" || environment === "empty");
assert.ok(command);
const supervisor = createProcessSupervisor();
const run = await supervisor.spawn({
  mode: "anchored-shell",
  command,
  ...(environment === "inherited"
    ? {}
    : { env: environment === "empty" ? {} : { OPENCLAW_TEST_CHILD_ENV: "child" } }),
});
try {
  const result = await run.wait();
  await run.waitForExtinction!();
  console.log(JSON.stringify(result));
} finally {
  await supervisor.shutdown();
}
