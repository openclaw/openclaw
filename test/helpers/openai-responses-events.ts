import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";

export function createInterleavedResponsesToolEvents(): ResponseStreamEvent[] {
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: {
        type: "function_call",
        id: "fc_click",
        call_id: "call_click",
        name: "computer",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 2,
      item: {
        type: "function_call",
        id: "fc_type",
        call_id: "call_type",
        name: "computer",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fc_type",
      sequence_number: 3,
      delta: '{"action":"type","text":"hello"}',
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc_click",
      sequence_number: 4,
      delta: '{"action":"left_click","coordinate":[10,20]}',
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 5,
      item: {
        type: "function_call",
        id: "fc_click",
        call_id: "call_click",
        name: "computer",
        arguments: '{"action":"left_click","coordinate":[10,20]}',
        status: "completed",
      },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 6,
      item: {
        type: "function_call",
        id: "fc_type",
        call_id: "call_type",
        name: "computer",
        arguments: '{"action":"type","text":"hello"}',
        status: "completed",
      },
    },
  ];
}

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
