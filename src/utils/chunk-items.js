export function chunkItems(items, size) {
    if (size <= 0) {
        return [Array.from(items)];
    }
    const rows = [];
    for (let i = 0; i < items.length; i += size) {
        rows.push(items.slice(i, i + size));
    }
    return rows;
}
