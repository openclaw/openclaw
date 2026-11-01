export function createSharedCommandHandlers(
  sendMessage: (text: string) => Promise<void>,
  addSystem: (text: string) => void,
) {
  return {
    btw: async (args: string, raw: string) => {
      if (args) {
        await sendMessage(raw);
      } else {
        addSystem("Usage: /btw <side question>");
      }
    },
    queue: async (_args: string, raw: string) => await sendMessage(raw),
    followup: async (_args: string, raw: string) => await sendMessage(raw),
    followupmode: async (_args: string, raw: string) => await sendMessage(raw),
    interrupt: async (_args: string, raw: string) => await sendMessage(raw),
  };
}
