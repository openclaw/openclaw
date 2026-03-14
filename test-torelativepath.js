// Test toRelativePathInRoot on Windows
import path from "node:path";

function toRelativePathInRoot(root, candidate, options) {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(rootResolved, resolved);
  
  console.log("Root resolved:", rootResolved);
  console.log("Candidate resolved:", resolved);
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
const candidate = "memory";

console.log("Test: Relative path 'memory'");
console.log("Root:", root);
console.log("Candidate:", candidate);
try {
  const result = toRelativePathInRoot(root, candidate);
  console.log("Result:", result);
} catch (err) {
  console.log("Error:", err.message);
}
