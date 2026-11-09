export function stallCpuOwner(durationMs = 1_200) {
  const until = Date.now() + durationMs;
  stallCpuLeaf(until);
}

function stallCpuLeaf(until: number) {
  while (Date.now() < until) {
    Math.sqrt(Date.now());
  }
}
