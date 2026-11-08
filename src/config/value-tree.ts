import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function visitConfigValueTree(
  value: unknown,
  visit: (candidate: unknown, path: readonly string[]) => boolean,
  rootPath: readonly string[] = [],
): void {
  type Frame = { kind: "leave" } | { kind: "visit"; value: unknown; key?: string };
  const currentPath = [...rootPath];
  const pending: Frame[] = [{ kind: "visit", value }];
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.kind === "leave") {
      currentPath.pop();
      continue;
    }
    if (frame.key !== undefined) {
      currentPath.push(frame.key);
      pending.push({ kind: "leave" });
    }
    if (!visit(frame.value, currentPath)) {
      continue;
    }
    const entries =
      Array.isArray(frame.value) || isRecord(frame.value) ? Object.entries(frame.value) : [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      pending.push({ kind: "visit", key, value: child });
    }
  }
}

export function rejectConfigNonFiniteNumbers(value: unknown): void {
  visitConfigValueTree(value, (candidate) => {
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error(`Value must be a finite number, got ${String(candidate)}`);
      }
    }
    return true;
  });
}
