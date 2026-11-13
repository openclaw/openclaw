import fs from "node:fs";
const assigned = { recursive: false };
assigned.recursive = true;
fs.readdirSync("root", assigned);
const merged = {};
Object.assign(merged, { recursive: true });
fs.readdirSync("root", merged);
const escaped = { recursive: false };
change(escaped);
fs.readdirSync("root", escaped);
const original = { recursive: false };
const alias = original;
alias.recursive = true;
fs.readdirSync("root", original);
const removed = { recursive: false };
delete removed.recursive;
fs.readdirSync("root", removed);
const published = { recursive: false };
const container = { published };
fs.readdirSync("root", published);
const stable = { recursive: false };
fs.readdirSync("root", stable);
fs.readdirSync("root", stable);
function onRead() {}
fs.readdir("root", onRead);
const callback = () => {};
fs.readdir("root", callback);
const callbackAlias = onRead;
fs.readdir("root", callbackAlias);
declare function change(value: unknown): void;
void container;

const delayed = { recursive: false };
const delayedAlias = delayed;
Object.assign(delayed, { recursive: true });
fs.readdirSync("root", delayedAlias);
export const exposed = { recursive: false };
fs.readdirSync("root", exposed);
const captured = { recursive: false };
mutateCaptured();
fs.readdirSync("root", captured);
function mutateCaptured() {
  change(captured);
}

const loopAssigned = { recursive: false };
for (let i = 0; i < 2; i++) {
  fs.readdirSync("root", loopAssigned);
  Object.assign(loopAssigned, { recursive: true });
}
const loopAliased = { recursive: false };
for (const directory of ["one", "two"]) {
  fs.readdirSync(directory, loopAliased);
  const alias = loopAliased;
  alias.recursive = true;
}
const moduleOptions = { recursive: false };
export function readLater() {
  fs.readdirSync("root", moduleOptions);
}
Object.assign(moduleOptions, { recursive: true });
const whileOptions = { recursive: false };
while (condition()) {
  fs.readdirSync("root", whileOptions);
  change(whileOptions);
}
const doOptions = { recursive: false };
do {
  fs.readdirSync("root", doOptions);
  change(doOptions);
} while (condition());
const forInOptions = { recursive: false };
for (const directory in { one: 1, two: 2 }) {
  fs.readdirSync(directory, forInOptions);
  change(forInOptions);
}
// A later escape in the same straight-line function cannot affect this call.
function readBeforeEscape() {
  const local = { recursive: false };
  fs.readdirSync("root", local);
  change(local);
}
declare function condition(): boolean;
void readBeforeEscape;
