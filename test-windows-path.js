// Test Windows path behavior
import path from "node:path";

// Simulate Windows paths
const root = "C:\\Users\\test\\openclaw-new";
const candidate = "C:\\Users\\test\\openclaw-new\\memory";

console.log("Root:", root);
console.log("Candidate:", candidate);
console.log("Root resolved:", path.resolve(root));
console.log("Candidate resolved:", path.resolve(candidate));

const relative = path.relative(path.resolve(root), path.resolve(candidate));
console.log("Relative:", relative);
console.log("Relative starts with ..:", relative.startsWith(".."));
console.log("Relative is absolute:", path.isAbsolute(relative));
console.log("Relative === '' || relative === '.':", relative === "" || relative === ".");

// Test with trailing separator
const rootWithSep = root + "\\";
console.log("\n--- With trailing separator ---");
console.log("Root with sep:", rootWithSep);
console.log("Root with sep resolved:", path.resolve(rootWithSep));
const relative2 = path.relative(path.resolve(rootWithSep), path.resolve(candidate));
console.log("Relative2:", relative2);
