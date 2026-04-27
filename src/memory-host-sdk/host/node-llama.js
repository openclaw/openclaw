const NODE_LLAMA_CPP_MODULE = "node-llama-cpp";
export async function importNodeLlamaCpp() {
    return import(NODE_LLAMA_CPP_MODULE);
}
