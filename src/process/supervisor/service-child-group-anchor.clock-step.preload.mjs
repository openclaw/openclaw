// Test preload for service-child-group-anchor clock-step regression.
//
// Injected via `--import` into the anchor subprocess. It wraps Date.now so that,
// once a marker file appears (created by the test AFTER cleanup has started and
// the budget is seeded), every subsequent wall-clock read returns a persistent
// offset — simulating a sustained NTP slew. Unlike a one-shot step this keeps the
// anchor's per-tick re-reads of the wall-clock budget polluted for the whole
// cleanup observation window, which is what makes a forward jump collapse the
// budget and a backward jump inflate it on the pre-fix Date.now implementation.
import fs from "node:fs";

const STEP_FILE = process.env.ANCHOR_TEST_STEP_FILE;
const OFFSET = Number(process.env.ANCHOR_TEST_OFFSET || 0);
const realNow = Date.now.bind(Date);
let stepped = false;
Date.now = function () {
  if (!stepped && STEP_FILE && fs.existsSync(STEP_FILE)) {
    stepped = true;
    process.stderr.write(`[anchor-clock-step] wall-clock STEP armed: +${OFFSET}ms\n`);
  }
  return stepped ? realNow() + OFFSET : realNow();
};
process.stderr.write(`[anchor-clock-step] preload loaded offset=${OFFSET}\n`);
