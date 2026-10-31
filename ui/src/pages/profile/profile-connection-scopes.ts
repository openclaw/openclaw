export const sameConnectionScopes = (
  left: readonly string[] | null,
  right: readonly string[] | null,
) => {
  if (left === null || right === null) {
    return left === right;
  }
  const leftScopes = new Set(left);
  const rightScopes = new Set(right);
  return (
    leftScopes.size === rightScopes.size && [...leftScopes].every((scope) => rightScopes.has(scope))
  );
};
