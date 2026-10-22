/** The runtime config owner publishes identity facts before notifying consumers. */
export const runtimeConfigPublication: {
  current?: { config: object; revision: object };
} = {};
