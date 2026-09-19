import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

export function useSpawnBrokerTestFixture(afterEach: (close: () => Promise<void>) => unknown) {
  const brokers = new Set<SpawnBrokerHost>();
  afterEach(async () => {
    await Promise.all([...brokers].map((broker) => broker.close()));
    brokers.clear();
  });
  return async () => {
    if (process.platform === "win32" || process.versions.bun) {
      return undefined;
    }
    const broker = createSpawnBrokerHost();
    brokers.add(broker);
    await broker.ready();
    return broker;
  };
}
