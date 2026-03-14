// Test fixed toRelativePathInRoot on Windows
import path from "node:path";

function toRelativePathInRoot(root, candidate, options) {
  const rootResolved = path.resolve(root);
  // If candidate is a relative path, resolve it against the root
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  const relative = path.relative(rootResolved, resolved);
  
  console.log("Root resolved:", rootResolved);
  console.log("Candidate:", candidate);
  console.log("Resolved:", resolved);
  console.log("Relative:", relative);
  
  if (relative === "" || relative === ".") {
    if (options?.allowRoot) {
      return "";
    }
    throw new Error(`Path escapes workspace root: ${candidate}`);
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${candidate}`);
  }
  return relative;
}

// Test case from issue - relative path
const root = "C:\\Users\\test\\openclaw-new";

console.log("Test 1: Relative path 'memory'");
const candidate1 = "memory";
console.log("Candidate:", candidate1);
try {
  const result = toRelativePathInRoot(root, candidate1);
  console.log("Result:", result);
} catch (err) {
  console.log("Error:", err.message);
}
console.log();

console.log("Test 2: Relative path 'memory/2026-03-01.md'");
const candidate2 = "memory/2026-03-01.md";
console.log("Candidate:", candidate2);
try {
  const result = toRelativePathInRoot(root, candidate2);
  console.log("Result:", result);
} catch (err) {
  console.log("Error:", err.message);
}
console.log();

console.log("Test 3: Absolute path inside workspace");
const candidate3 = "C:\\Users\\test\\openclaw-new\\memory";
console.log("Candidate:", candidate3);
try {
  const result = toRelativePathInRoot(root, candidate3);
  console.log("Result:", result);
} catch (err) {
  console.log("Error:", err.message);
}
console.log();

console.log("Test 4: Absolute path outside workspace");
const candidate4 = "C:\\Users\\test\\other\\memory";
console.log("Candidate:", candidate4);
try {
  const result = toRelativePathInRoot(root, candidate4);
  console.log("Result:", result);
} catch (err) {
  console.log("Error:", err.message);
}
console.log();

console.log("Test 5: Relative path with traversal");
const candidate5 = "../other/memory";
console.log("Candidate:", candidate5);
try {
  const result = toRelativePathInRoot(root, candidate5);
  console.log("Result:", result);
} catch (err) {
  console.log("Error:", err.message);
}
