export type MobileSheetScrollFadeConnection = {
  schedule(): void;
  remove(port: HTMLElement): void;
  dispose(): void;
};

export function createMobileSheetScrollFades() {
  const ports = new Set<HTMLElement>();
  let connection: MobileSheetScrollFadeConnection | undefined;
  const register = (port: HTMLElement) => {
    ports.add(port);
    connection?.schedule();
    return () => {
      ports.delete(port);
      connection?.remove(port);
    };
  };
  const connect = (
    attach: (ports: ReadonlySet<HTMLElement>) => MobileSheetScrollFadeConnection,
  ) => {
    connection?.dispose();
    const current = attach(ports);
    connection = current;
    current.schedule();
    return () => {
      current.dispose();
      if (connection === current) {
        connection = undefined;
      }
    };
  };
  return { register, connect };
}

export type MobileSheetScrollFades = ReturnType<typeof createMobileSheetScrollFades>;
