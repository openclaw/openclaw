export function createResponsesDoneArgumentEvents() {
  const firstItem = {
    type: "function_call",
    id: "fc_recovered_first",
    call_id: "call_recovered_first",
    name: "read",
  };
  const secondItem = {
    type: "function_call",
    id: "fc_recovered_second",
    call_id: "call_recovered_second",
    name: "write",
  };

  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...firstItem, arguments: "" },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...secondItem, arguments: "" },
    },
    { type: "response.function_call_arguments.delta", delta: '{"ambiguous":true}' },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: firstItem.id,
      arguments: '{"path":"README.md"}',
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 1,
      item_id: secondItem.id,
      arguments: '{"path":"README.md","text":"ok"}',
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: firstItem.id,
        call_id: firstItem.call_id,
      },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "function_call",
        id: secondItem.id,
        call_id: secondItem.call_id,
      },
    },
    {
      type: "response.completed",
      response: { id: "resp_recovered_parallel", status: "completed" },
    },
  ];
}
