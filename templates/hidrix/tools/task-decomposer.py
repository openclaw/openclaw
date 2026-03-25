#!/usr/bin/env python3
"""
Task Decomposer for EVOX Agent Swarm
Usage: python task-decomposer.py "Complex task description" -o tasks.json
"""

import argparse
import json
import hashlib
from datetime import datetime

def decompose_task(task_description, max_subtasks=5):
    """
    Simple task decomposition based on keywords.
    In production, this would use an LLM for intelligent decomposition.
    """
    
    task_id = hashlib.md5(task_description.encode()).hexdigest()[:8]
    
    # Keywords that suggest parallelizable work
    parallel_keywords = {
        'research': ['gather sources', 'fetch data', 'analyze findings', 'compile report'],
        'build': ['design', 'implement', 'test', 'document'],
        'compare': ['analyze option A', 'analyze option B', 'create comparison', 'recommend'],
        'setup': ['install dependencies', 'configure', 'test', 'document'],
        'analyze': ['collect data', 'process data', 'visualize', 'interpret'],
    }
    
    subtasks = []
    task_lower = task_description.lower()
    
    for keyword, default_subtasks in parallel_keywords.items():
        if keyword in task_lower:
            for i, subtask in enumerate(default_subtasks[:max_subtasks]):
                subtasks.append({
                    'id': f"{task_id}-{i+1}",
                    'parent_id': task_id,
                    'description': f"{subtask.title()}: {task_description}",
                    'status': 'pending',
                    'assigned_to': None,
                    'dependencies': [],
                    'created_at': datetime.now().isoformat()
                })
            break
    
    # If no keywords matched, create generic subtasks
    if not subtasks:
        generic = ['Plan approach', 'Execute main work', 'Review and refine', 'Document results']
        for i, subtask in enumerate(generic):
            subtasks.append({
                'id': f"{task_id}-{i+1}",
                'parent_id': task_id,
                'description': f"{subtask}: {task_description}",
                'status': 'pending',
                'assigned_to': None,
                'dependencies': [f"{task_id}-{i}"] if i > 0 else [],
                'created_at': datetime.now().isoformat()
            })
    
    return {
        'task_id': task_id,
        'description': task_description,
        'subtasks': subtasks,
        'total_subtasks': len(subtasks),
        'parallelizable': len([s for s in subtasks if not s['dependencies']]),
        'created_at': datetime.now().isoformat()
    }

def main():
    parser = argparse.ArgumentParser(description='Task Decomposer')
    parser.add_argument('task', help='Task description to decompose')
    parser.add_argument('-o', '--output', help='Output file (JSON)')
    parser.add_argument('-n', '--max-subtasks', type=int, default=5, help='Max subtasks')
    args = parser.parse_args()

    result = decompose_task(args.task, args.max_subtasks)
    
    output = json.dumps(result, indent=2)
    
    if args.output:
        with open(args.output, 'w') as f:
            f.write(output)
        print(f"✅ Task decomposed into {result['total_subtasks']} subtasks")
        print(f"   Parallelizable: {result['parallelizable']}")
        print(f"   Saved to: {args.output}")
    else:
        print(output)

if __name__ == '__main__':
    main()
