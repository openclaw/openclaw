// Test isPathInside on Windows
import path from "node:path";

function normalizeWindowsPathForComparison(input) {
  let normalized = path.win32.normalize(input);
  if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
    if (normalized.toUpperCase().startsWith("UNC\\")) {
      normalized = `\\\\${normalized.slice(4)}`;
    }
  }
  return normalized.replaceAll("/", "\\").toLowerCase();
}

function isPathInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);

  if (process.platform === "win32") {
    const rootForCompare = normalizeWindowsPathForComparison(resolvedRoot);
    const targetForCompare = normalizeWindowsPathForComparison(resolvedTarget);
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    console.log("Root for compare:", rootForCompare);
    console.log("Target for compare:", targetForCompare);
    console.log("Relative:", relative);
    console.log("Relative starts with ..:", relative.startsWith(".."));
    console.log("Relative is absolute:", path.win32.isAbsolute(relative));
    return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
  }

  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Test case from issue
const root = "C:\\Users\\test\\openclaw-new";
const target = "C:\\Users\\test\\openclaw-new\\memory";

console.log("Test 1: Normal paths");
console.log("Root:", root);
console.log("Target:", target);
const result1 = isPathInside(root, target);
console.log("Is inside:", result1);
console.log();

// Test with different casing
const root2 = "C:\\Users\\test\\openclaw-new";
const target2 = "C:\\Users\\test\\openclaw-new\\Memory";

console.log("Test 2: Different casing");
console.log("Root:", root2);
console.log("Target:", target2);
const result2 = isPathInside(root2, target2);
console.log("Is inside:", result2);
console.log();

// Test with trailing separator
const root3 = "C:\\Users\\test\\openclaw-new\\";
const target3 = "C:\\Users\\test\\openclaw-new\\memory";

console.log("Test 3: With trailing separator");
console.log("Root:", root3);
console.log("Target:", target3);
const result3 = isPathInside(root3, target3);
console.log("Is inside:", result3);
console.log();

// Test with relative path
const root4 = "C:\\Users\\test\\openclaw-new";
const target4 = "memory";

console.log("Test 4: Relative target path");
console.log("Root:", root4);
console.log("Target:", target4);
const result4 = isPathInside(root4, target4);
console.log("Is inside:", result4);
