// Resolve the plugin's typescript-eslint dependencies with their supported compiler.
import solid from "eslint-plugin-solid";

const removedApi = solid.rules["removed-api"];

export default {
  ...solid,
  rules: {
    ...solid.rules,
    "removed-api": {
      ...removedApi,
      create(context) {
        return removedApi.create(
          Object.create(context, {
            report: {
              value(descriptor) {
                // eslint-plugin-solid 0.18.1 predates rc.16 restoring this core export.
                if (
                  descriptor.messageId === "removed" &&
                  descriptor.data?.name === "createDeferred" &&
                  descriptor.node.parent.source.value === "solid-js"
                ) {
                  return;
                }
                context.report(descriptor);
              },
            },
          }),
        );
      },
    },
  },
};
