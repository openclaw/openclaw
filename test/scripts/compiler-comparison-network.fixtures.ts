import type { CompilerNetworkEvidence } from "../../scripts/lib/compiler-comparison-io.mts";

export function networkFixture(fallbacks = false): CompilerNetworkEvidence {
  const devices = [
    ["lo", "772", "0x9", "unknown"],
    ...(fallbacks
      ? [
          ["ip6gre0", "823", "0x80", "down"],
          ["ip6tnl0", "769", "0x80", "down"],
          ["sit0", "776", "0x80", "down"],
          ["tunl0", "768", "0x80", "down"],
        ]
      : []),
  ];
  return {
    policy: "linux-none-with-inactive-fallbacks-v1",
    collectorNamespace: "net:[1]",
    probe: [
      "namespace\tnet:[2]",
      ...["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(
        (name) => "capability\t" + name + "\t0000000000000000",
      ),
      "no-new-privs\t1",
      ...devices.map((device) => ["sysfs", ...device].join("\t")),
      ...devices.map(([name]) => "proc\t" + name),
      "routes4\tcomplete",
      "route6\tlo",
      "routes6\tcomplete",
      "tcp\tENETUNREACH",
      "",
    ].join("\n"),
  };
}
