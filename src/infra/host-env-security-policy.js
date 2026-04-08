import HOST_ENV_SECURITY_POLICY_JSON from "./host-env-security-policy.json" with { type: "json" };

function sortUniqueUppercase(values) {
  return Object.freeze(
    Array.from(new Set(values.map((value) => value.toUpperCase()))).toSorted((a, b) =>
      a.localeCompare(b),
    ),
  );
}

function derivePolicyArrays(policy) {
  const blockedEverywhereKeys = policy.blockedEverywhereKeys ?? [];
  const blockedOverrideOnlyKeys = policy.blockedOverrideOnlyKeys ?? [];

  return {
    blockedKeys: sortUniqueUppercase(blockedEverywhereKeys),
    blockedOverrideKeys: sortUniqueUppercase(blockedOverrideOnlyKeys),
    blockedPrefixes: sortUniqueUppercase(policy.blockedPrefixes ?? []),
    blockedOverridePrefixes: sortUniqueUppercase(policy.blockedOverridePrefixes ?? []),
  };
}

export function loadHostEnvSecurityPolicy(rawPolicy = HOST_ENV_SECURITY_POLICY_JSON) {
  const derived = derivePolicyArrays(rawPolicy);
  return Object.freeze({
    blockedEverywhereKeys: Object.freeze(rawPolicy.blockedEverywhereKeys ?? []),
    blockedOverrideOnlyKeys: Object.freeze(rawPolicy.blockedOverrideOnlyKeys ?? []),
    blockedPrefixes: derived.blockedPrefixes,
    blockedOverridePrefixes: derived.blockedOverridePrefixes,
    blockedKeys: derived.blockedKeys,
    blockedOverrideKeys: derived.blockedOverrideKeys,
  });
}

export const HOST_ENV_SECURITY_POLICY = loadHostEnvSecurityPolicy();
